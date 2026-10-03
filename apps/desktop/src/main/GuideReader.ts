import { Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import type { WebContentsView } from "electron"
import { ProviderSession } from "./ProviderSession.ts"

/**
 * Reads YouTube TV's live guide the way its own page loads it. A hidden, muted view on the provider session
 * opens the guide; the debugger, attached to that view alone, reads the body of the page's guide response; the
 * view then closes, because the guide plays a preview while it is open. Nothing is injected, and no request is
 * made or changed.
 */
export class GuideReader extends Context.Service<
  GuideReader,
  {
    /** Each guide response, as the page received it. */
    readonly guides: Stream.Stream<string>
    /** Asks for a read. Asking while a read waits adds nothing; reads are at least two minutes apart. */
    readonly readSoon: Effect.Effect<void>
  }
>()("sportal/desktop/GuideReader") {
  static readonly layer = Layer.effect(
    GuideReader,
    Effect.gen(function* () {
      const providers = yield* ProviderSession
      const guides = yield* PubSub.unbounded<string>()
      const requests = yield* Queue.sliding<void>(1)

      const read = Effect.gen(function* () {
        const view = yield* Effect.acquireRelease(providers.createView, (view) =>
          Effect.sync(() => {
            if (!view.webContents.isDestroyed()) view.webContents.close()
          })
        )
        view.webContents.setAudioMuted(true)
        return yield* guideResponse(view).pipe(Effect.timeoutOption("30 seconds"))
      }).pipe(
        Effect.scoped,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.logWarning("GuideReader: no guide response within 30 seconds"),
            onSome: (guide) => PubSub.publish(guides, guide)
          })
        ),
        Effect.catchTag("GuideNotRead", (failure) =>
          Effect.logWarning("GuideReader: the guide could not be read", failure.cause)
        )
      )

      // The first read waits to be asked, so the web UI is listening before a guide arrives.
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(requests).pipe(Effect.andThen(read), Effect.andThen(Effect.sleep("2 minutes")))
        )
      )
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep("15 minutes").pipe(Effect.andThen(Queue.offer(requests, undefined))))
      )

      return GuideReader.of({
        guides: Stream.fromPubSub(guides),
        readSoon: Queue.offer(requests, undefined).pipe(Effect.asVoid)
      })
    })
  )
}

class GuideNotRead extends Schema.TaggedError<GuideNotRead>()("GuideNotRead", { cause: Schema.Defect() }) {}

/** Opens the guide in `view` and resumes with the body of its guide response. */
function guideResponse(view: WebContentsView) {
  return Effect.callback<string, GuideNotRead>((resume) => {
    const inspector = view.webContents.debugger
    const guideRequests = new Set<string>()
    const failed = (cause: unknown) => resume(Effect.fail(new GuideNotRead({ cause })))

    const onMessage = (_event: unknown, method: string, params: unknown) => {
      if (method === "Network.requestWillBeSent") {
        const sent = decodeRequestWillBeSent(params)
        if (Option.isSome(sent) && isGuideRequest(sent.value.request)) guideRequests.add(sent.value.requestId)
      }
      if (method === "Network.loadingFinished") {
        const finished = decodeLoadingFinished(params)
        if (Option.isNone(finished) || !guideRequests.has(finished.value.requestId)) return
        inspector
          .sendCommand("Network.getResponseBody", { requestId: finished.value.requestId })
          .then((raw: unknown) => {
            const body = decodeResponseBody(raw)
            if (Option.isNone(body)) return failed("the response body had an unexpected shape")
            const { body: text, base64Encoded } = body.value
            resume(Effect.succeed(base64Encoded ? Buffer.from(text, "base64").toString("utf8") : text))
          }, failed)
      }
    }

    try {
      inspector.attach("1.3")
    } catch (cause) {
      failed(cause)
      return
    }
    inspector.on("message", onMessage)
    // A load that fails or is cut short shows up as the 30-second timeout; its rejection carries nothing more.
    inspector
      .sendCommand("Network.enable")
      .then(() => view.webContents.loadURL(guideUrl).catch(() => undefined), failed)
    return Effect.sync(() => {
      inspector.removeListener("message", onMessage)
      if (inspector.isAttached()) inspector.detach()
    })
  })
}

const guideUrl = "https://tv.youtube.com/live"

const decodeRequestWillBeSent = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({ url: Schema.String, postData: Schema.optional(Schema.String) })
  })
)

/** The guide page asks for its guide with `browse`, naming the guide's browse id in the request body. */
function isGuideRequest(request: { readonly url: string; readonly postData?: string | undefined }) {
  return (
    URL.canParse(request.url) &&
    new URL(request.url).pathname === "/youtubei/v1/browse" &&
    request.postData?.includes('"FEunplugged_epg"') === true
  )
}

const decodeLoadingFinished = Schema.decodeUnknownOption(Schema.Struct({ requestId: Schema.String }))

const decodeResponseBody = Schema.decodeUnknownOption(
  Schema.Struct({ body: Schema.String, base64Encoded: Schema.Boolean })
)
