import { createHash } from "node:crypto"
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Schema,
  Stream
} from "effect"
import type { Session } from "electron"
import { ProviderSession } from "./ProviderSession.ts"

/**
 * Reads YouTube TV's live guide with the guide's own request, sent as the signed-in account on the provider
 * session: the guide page's config gives the client context, and the session's `SAPISID` cookie signs the
 * request. No view is opened and no player is touched. One response covers the next 24 hours.
 */
export class GuideReader extends Context.Service<
  GuideReader,
  {
    /** Each guide response, as received. */
    readonly guides: Stream.Stream<string>
    /** Asks for a read. The first ask starts a read every 5 minutes; asking while a read waits adds nothing. */
    readonly readSoon: Effect.Effect<void>
  }
>()("sportal/desktop/GuideReader") {
  static readonly layer = Layer.effect(
    GuideReader,
    Effect.gen(function* () {
      const providers = yield* ProviderSession
      const guides = yield* PubSub.unbounded<string>()
      const requests = yield* Queue.sliding<void>(1)

      const read = readGuide(providers.session).pipe(
        Effect.flatMap((guide) => PubSub.publish(guides, guide)),
        Effect.catchTag("GuideNotRead", (failure) =>
          Effect.logWarning(`GuideReader: the guide could not be read: ${failure.reason}`)
        ),
        // A read that goes wrong any other way must not end the loop; only interruption does.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logError("GuideReader: a read failed", cause)
        )
      )
      yield* Effect.forkScoped(Effect.forever(Queue.take(requests).pipe(Effect.andThen(read))))

      // The first read waits to be asked, so the web UI is listening before a guide arrives.
      const asked = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        Deferred.await(asked).pipe(
          Effect.andThen(
            Effect.forever(Effect.sleep("5 minutes").pipe(Effect.andThen(Queue.offer(requests, undefined))))
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

class GuideNotRead extends Schema.TaggedError<GuideNotRead>()("GuideNotRead", { reason: Schema.String }) {}

/** Reads the guide page's client config, then sends the guide request it describes, signed as the account. */
function readGuide(session: Session) {
  return Effect.gen(function* () {
    const context = clientContext(yield* send(session, `${origin}/live`, {}))
    if (Option.isNone(context))
      return yield* Effect.fail(new GuideNotRead({ reason: "the guide page has no client config" }))
    const cookies = yield* Effect.tryPromise({
      try: () => session.cookies.get({ url: origin, name: "SAPISID" }),
      catch: (cause) =>
        new GuideNotRead({ reason: `the session's cookies could not be read: ${String(cause)}` })
    })
    const sapisid = Arr.head(cookies)
    if (Option.isNone(sapisid))
      return yield* Effect.fail(new GuideNotRead({ reason: "the session has no YouTube sign-in (SAPISID)" }))
    // YouTube's web clients sign each request with the time and the session's SAPISID, as the guide page does.
    const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const signature = createHash("sha1").update(`${seconds} ${sapisid.value.value} ${origin}`).digest("hex")
    return yield* send(session, `${origin}/youtubei/v1/browse?prettyPrint=false`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "x-origin": origin,
        authorization: `SAPISIDHASH ${seconds}_${signature}`
      },
      body: JSON.stringify({ context: context.value, browseId: "FEunplugged_epg" })
    })
  })
}

const origin = "https://tv.youtube.com"

/** Sends one request on the session and reads its body. A failed request or a status outside 2xx is `GuideNotRead`. */
function send(session: Session, url: string, init: RequestInit) {
  const path = new URL(url).pathname
  return Effect.tryPromise({
    try: () =>
      session
        .fetch(url, init)
        .then((response) => response.text().then((body) => ({ status: response.status, body }))),
    catch: (cause) => new GuideNotRead({ reason: `${path} could not be reached: ${String(cause)}` })
  }).pipe(
    Effect.flatMap(({ status, body }) =>
      status >= 200 && status < 300
        ? Effect.succeed(body)
        : Effect.fail(
            new GuideNotRead({
              reason: `${path} answered ${status}${status === 401 || status === 403 ? " (signed out of YouTube TV?)" : ""}`
            })
          )
    )
  )
}

/** The client context a guide page publishes in its `ytcfg.set({...})` config, which the guide request repeats. */
function clientContext(page: string) {
  return Arr.findFirst(configs(page), (config) =>
    Option.map(decodeConfig(config), (decoded) => decoded.INNERTUBE_CONTEXT)
  )
}

/** Each `ytcfg.set({...})` object literal in a page, found by matching braces outside strings. */
function configs(page: string) {
  const found: Array<string> = []
  const call = "ytcfg.set("
  let at = page.indexOf(`${call}{`)
  while (at !== -1) {
    const start = at + call.length
    let depth = 0
    let quote: string | undefined
    let end = start
    for (; end < page.length; end++) {
      const char = page[end]
      if (quote !== undefined) {
        if (char === "\\") end++
        else if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") quote = char
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) break
    }
    found.push(page.slice(start, end + 1))
    at = page.indexOf(`${call}{`, end)
  }
  return found
}

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ INNERTUBE_CONTEXT: Schema.Record(Schema.String, Schema.Unknown) }))
)
