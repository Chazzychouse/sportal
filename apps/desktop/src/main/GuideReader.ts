import { Cause, Context, Deferred, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import type { WebContentsView } from "electron"
import { load, ProviderSession } from "./ProviderSession.ts"

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
        ),
        // A read that goes wrong any other way must not end the loop; only interruption does.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logError("GuideReader: a read failed", cause)
        )
      )

      // The first read waits to be asked, so the web UI is listening before a guide arrives.
      const asked = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(requests).pipe(Effect.andThen(read), Effect.andThen(Effect.sleep("2 minutes")))
        )
      )
      // Periodic reads begin with the first ask.
      yield* Effect.forkScoped(
        Deferred.await(asked).pipe(
          Effect.andThen(
            Effect.forever(Effect.sleep("15 minutes").pipe(Effect.andThen(Queue.offer(requests, undefined))))
          )
        )
      )

      return GuideReader.of({
        guides: Stream.fromPubSub(guides),
        readSoon: Deferred.succeed(asked, undefined).pipe(
          Effect.andThen(Queue.offer(requests, undefined)),
          Effect.asVoid
        )
      })
    })
  )
}

class GuideNotRead extends Schema.TaggedError<GuideNotRead>()("GuideNotRead", { cause: Schema.Defect() }) {}

/**
 * Opens the guide in `view` and waits for the body of its guide response. The debugger attaches for as long as
 * the surrounding scope lives, and detaches, with its listener removed, however the read ends.
 */
function guideResponse(view: WebContentsView) {
  return Effect.gen(function* () {
    const outcome = yield* Deferred.make<string, GuideNotRead>()
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => listen(view, outcome),
        catch: (cause) => new GuideNotRead({ cause })
      }),
      (stop) => Effect.sync(stop)
    )
    yield* Effect.forkScoped(
      Effect.tryPromise({
        try: () => view.webContents.debugger.sendCommand("Network.enable"),
        catch: (cause) => new GuideNotRead({ cause })
      }).pipe(
        Effect.andThen(load(view.webContents, guideUrl)),
        // A page navigating on by itself aborts its load; the guide response is still on its way.
        Effect.catchTag("LoadFailed", (failure) =>
          failure.code === "ERR_ABORTED" ? Effect.void : Effect.fail(new GuideNotRead({ cause: failure }))
        ),
        Effect.catchTag("GuideNotRead", (failure) => Deferred.fail(outcome, failure))
      )
    )
    return yield* Deferred.await(outcome)
  })
}

/** Attaches the debugger and completes `outcome` with the guide response's body; returns the way to detach. */
function listen(view: WebContentsView, outcome: Deferred.Deferred<string, GuideNotRead>) {
  const inspector = view.webContents.debugger
  const guideRequests = new Set<string>()
  const fail = (cause: unknown) => Deferred.doneUnsafe(outcome, Effect.fail(new GuideNotRead({ cause })))

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
          if (Option.isNone(body)) return fail("the response body had an unexpected shape")
          const { body: text, base64Encoded } = body.value
          Deferred.doneUnsafe(
            outcome,
            Effect.succeed(base64Encoded ? Buffer.from(text, "base64").toString("utf8") : text)
          )
        }, fail)
    }
  }

  inspector.attach("1.3")
  inspector.on("message", onMessage)
  return () => {
    inspector.removeListener("message", onMessage)
    if (inspector.isAttached()) inspector.detach()
  }
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
