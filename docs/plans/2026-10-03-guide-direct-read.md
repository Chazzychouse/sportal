# Guide Direct Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shell reads YouTube TV's guide with one direct, read-only request on the signed-in provider session, instead of opening a hidden guide page and watching it through the debugger.

**Architecture:** `GuideReader` keeps its interface (`guides`, `readSoon`), so `main.ts`, the bridge, the web relay, and the Hub are unchanged. Inside, a read is two requests on the provider session: the guide page, for the client context in its `ytcfg.set` config, then `POST /youtubei/v1/browse` for `FEunplugged_epg`, signed with `SAPISIDHASH` from the session's `SAPISID` cookie. `ProviderSession` exposes its session for this. The web UI's re-read timer and `Stage#nextBegin` go, because reads every 5 minutes cover a waiting airing.

**Tech Stack:** TypeScript 6, Effect 4.0.0, Electron 44 (castlabs), React 19, Vitest 5.

**Spec:** `docs/specs/2026-10-03-guide-direct-read-design.md`, with the spike's findings in its section 0.

## Global Constraints

- Read `AGENTS.md` first; its file-layout and in-file order rules are requirements.
- Effect is exactly `4.0.0`; check APIs in `node_modules/.pnpm/effect@4.0.0/node_modules/effect/src/`.
- `pnpm check` passes before every commit.
- The shell sends no request but `GET https://tv.youtube.com/live` and the guide `browse` for `FEunplugged_epg`. Never a continuation or a sort request: a sort request changes the account's guide sort.
- Request shape, from the spike: body `{ context: INNERTUBE_CONTEXT, browseId: "FEunplugged_epg" }`; headers `content-type: application/json`, `origin` and `x-origin` `https://tv.youtube.com`, `authorization: SAPISIDHASH <s>_<sha1("<s> <SAPISID> https://tv.youtube.com")>` with `<s>` the current time in whole seconds. URL `https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false`.
- Reads: the first when the web UI first asks, then every 5 minutes, and whenever asked. No minimum gap, no timeout of our own.
- Nothing is logged that holds a cookie, a header, or the payload.

## Where this plan differs from the spec

- **The first read still waits for the web UI's first ask**, as today. The web UI asks as soon as its connection to the Hub is up, and a guide read before it listens would be lost.
- **`ProviderSession` exposes its `session`**, not a `fetch`: a read needs the session's cookies as well as its `fetch`.

## File map

```
apps/desktop/src/main/ProviderSession.ts       Task 1: exposes `session`
apps/desktop/src/main/GuideReader.ts           Task 1: rewritten
apps/desktop/src/main/GuideReader.test.ts      Task 1: rewritten
apps/web/src/stage/StageView.tsx               Task 2: re-read timer removed
packages/domain/src/Stage.ts, Stage.test.ts    Task 2: `nextBegin` removed
packages/api/src/ShellBridge.ts                Task 2: `readGuide` and `onGuideRead` docs
apps/hub/src/source/youtube-tv/YouTubeTv.ts    Task 2: logs each guide's counts
CONTEXT.md, docs/technical-spec.md, docs/adr/0002-desktop-shell-playback.md,
docs/game-day-checklist.md, docs/specs/2026-10-03-guide-matched-channels-design.md   Task 3
```

---

### Task 1: The guide reader sends the guide request

**Files:**
- Modify: `apps/desktop/src/main/ProviderSession.ts`
- Rewrite: `apps/desktop/src/main/GuideReader.ts`
- Rewrite: `apps/desktop/src/main/GuideReader.test.ts`

**Interfaces:**
- Consumes: `ProviderSession` (`session: Session` added here).
- Produces: `GuideReader` with the same shape as today: `guides: Stream<string>`, `readSoon: Effect<void>`.

- [ ] **Step 1: Write the failing tests** — replace `GuideReader.test.ts` with:

```ts
import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

/** What the provider session answers; each test sets what it needs before it asks for a read. */
const answers = {
  page: "",
  guide: { status: 200, body: "" },
  cookies: [] as Array<{ name: string; value: string }>
}
const sent = vi.fn((url: string, _init?: RequestInit) =>
  Promise.resolve(
    url === "https://tv.youtube.com/live"
      ? new Response(answers.page)
      : new Response(answers.guide.body, { status: answers.guide.status })
  )
)

vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      fetch: sent,
      cookies: { get: () => Promise.resolve(answers.cookies) }
    })
  },
  WebContentsView: vi.fn()
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { GuideReader } = await import("./GuideReader.ts")

// The second config holds the context, and the first has a brace inside a string, as real pages do.
const guidePage = [
  '<script>ytcfg.set({"EXPERIMENT_FLAGS":{"note":"a } in a string"}});</script>',
  '<script>ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB_UNPLUGGED","clientVersion":"1.20260930.04.00"}}});</script>'
].join("")

describe("GuideReader", () => {
  it.effect("reads when asked: the guide request the page would send, signed as the account", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      yield* reader.readSoon
      yield* settle

      expect(yield* Fiber.join(guides)).toEqual(["the guide"])
      expect(sent.mock.calls.map(([url]) => url)).toEqual([
        "https://tv.youtube.com/live",
        "https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false"
      ])
      const init = sent.mock.calls[1]?.[1]
      const hash = createHash("sha1").update("0 the-sapisid https://tv.youtube.com").digest("hex")
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://tv.youtube.com",
          "x-origin": "https://tv.youtube.com",
          authorization: `SAPISIDHASH 0_${hash}`
        }
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        context: { client: { clientName: "WEB_UNPLUGGED", clientVersion: "1.20260930.04.00" } },
        browseId: "FEunplugged_epg"
      })
    }).pipe(Effect.scoped)
  )

  it.effect("does not read until asked, then reads every 5 minutes", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* settle
      yield* TestClock.adjust("20 minutes") // the web UI has not asked, so nothing is read
      yield* settle
      expect(sent).not.toHaveBeenCalled()
      yield* reader.readSoon
      yield* settle
      expect(sent).toHaveBeenCalledTimes(2)
      yield* TestClock.adjust("5 minutes")
      yield* settle
      expect(sent).toHaveBeenCalledTimes(4)
    }).pipe(Effect.scoped)
  )

  it.effect("logs a refused guide request as a likely sign-out, and reads again later", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      const guides = yield* collect(reader.guides, 1)
      answers.guide = { status: 401, body: "" }
      yield* reader.readSoon
      yield* settle
      expect(logs).toEqual([
        "GuideReader: the guide could not be read: /youtubei/v1/browse answered 401 (signed out of YouTube TV?)"
      ])
      answers.guide = { status: 200, body: "the guide" }
      yield* TestClock.adjust("5 minutes")
      yield* settle
      expect(yield* Fiber.join(guides)).toEqual(["the guide"])
    }).pipe(Effect.scoped)
  )

  it.effect("sends no guide request when the guide page has no client config", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      answers.page = "<html></html>"
      yield* reader.readSoon
      yield* settle
      expect(sent).toHaveBeenCalledTimes(1)
      expect(logs).toEqual(["GuideReader: the guide could not be read: the guide page has no client config"])
    }).pipe(Effect.scoped)
  )

  it.effect("sends no guide request when the session is not signed in", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      answers.cookies = []
      yield* reader.readSoon
      yield* settle
      expect(sent).toHaveBeenCalledTimes(1)
      expect(logs).toEqual([
        "GuideReader: the guide could not be read: the session has no YouTube sign-in (SAPISID)"
      ])
    }).pipe(Effect.scoped)
  )
})

/** Lets forked fibers and resolved promises run. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))).pipe(
  Effect.repeat({ times: 5 })
)

function collect<A>(stream: Stream.Stream<A>, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* stream.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    return fiber
  })
}

function attached(logs: Array<string> = []) {
  sent.mockClear()
  answers.page = guidePage
  answers.guide = { status: 200, body: "the guide" }
  answers.cookies = [{ name: "SAPISID", value: "the-sapisid" }]
  const capture = Logger.make<unknown, void>(({ message }) => {
    logs.push(String(Array.isArray(message) ? message[0] : message))
  })
  return Layer.build(
    GuideReader.layer.pipe(Layer.provide(ProviderSession.layer), Layer.provide(Logger.layer([capture])))
  ).pipe(Effect.map((context) => Context.get(context, GuideReader)))
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/GuideReader.test.ts`
Expected: FAIL (the reader still opens a view; `createView` is not called with a `WebContentsView` that has `webContents`).

- [ ] **Step 3: Expose the session** — in `ProviderSession.ts`, add to the service shape, first:

```ts
    /** The provider session itself, for the requests the shell sends as the signed-in account. */
    readonly session: Session
```

import `type Session` from `electron`, and add `session: providers,` first in `ProviderSession.of({ ... })`.

- [ ] **Step 4: Rewrite `GuideReader.ts`**

```ts
import { createHash } from "node:crypto"
import { Array as Arr, Cause, Clock, Context, Deferred, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
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
      catch: (cause) => new GuideNotRead({ reason: `the session's cookies could not be read: ${String(cause)}` })
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
    try: () => session.fetch(url, init).then((response) => response.text().then((body) => ({ status: response.status, body }))),
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
  return Arr.findFirst(configs(page), (config) => Option.map(decodeConfig(config), (decoded) => decoded.INNERTUBE_CONTEXT))
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
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run apps/desktop/src/main/GuideReader.test.ts apps/desktop/src/main/ProviderSession.test.ts apps/desktop/src/main/TileViews.test.ts`
Expected: PASS. Then `pnpm check`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ProviderSession.ts apps/desktop/src/main/GuideReader.ts apps/desktop/src/main/GuideReader.test.ts
git commit -m "feat(desktop): the guide reader sends the guide request itself; no hidden view, debugger, or preview"
```

### Task 2: Reads on a cadence replace the re-read timer; the Hub counts each guide

**Files:**
- Modify: `apps/web/src/stage/StageView.tsx` (the `nextBegin` effect, and the comment over `onGuideRead`)
- Modify: `packages/domain/src/Stage.ts` (remove `nextBegin`), `packages/domain/src/Stage.test.ts` (remove `describe("Stage#nextBegin")`)
- Modify: `packages/api/src/ShellBridge.ts` (docs of `onGuideRead`, `readGuide`)
- Modify: `apps/hub/src/source/youtube-tv/YouTubeTv.ts` (`readGuide`)

- [ ] **Step 1:** In `StageView.tsx`, delete the `nextBegin` constant and its `useEffect`, and the now-unused imports (`DateTime`, `Option` if nothing else uses them). The comment over `onGuideRead` becomes `// Listening first, then asking: the shell's first read waits for the web UI to ask.`
- [ ] **Step 2:** Remove `Stage#nextBegin` and its tests, and any import only it used (`Arr`, `DateTime.Order`).
- [ ] **Step 3:** In `ShellBridge.ts`:

```ts
  /** Calls `listener` with each guide the shell reads from the source, unchanged. Returns a function that stops the calls. */
  onGuideRead(listener: (guide: string) => void): () => void
  /** Asks the shell to read the guide now: at start, and when the Hub comes back. The shell also reads every 5 minutes. */
  readGuide(): void
```

- [ ] **Step 4:** In `YouTubeTv.ts` `readGuide`, after the zero-channel check:

```ts
          yield* Effect.logInfo(
            `YouTubeTv: read a guide of ${read.channels.length} channels and ${read.airings.length} airings`
          )
```

- [ ] **Step 5:** `pnpm check`. Expected: PASS.
- [ ] **Step 6: Commit** — `fix(web): the shell's cadence replaces the re-read timer; the Hub logs each guide's size`

### Task 3: Docs follow

- [ ] `CONTEXT.md` and `docs/technical-spec.md` glossary: **Guide reader** — "The shell component that reads a source's guide with the source's own guide request, sent on the provider session." Same row text in both. `technical-spec.md` tree: `GuideReader.ts      Reads the source's guide with its own request`.
- [ ] ADR 0002: replace the body of "Amendment: the guide reader" with the spec's section 4 text, dated 2026-10-03, pointing to the new spec; keep the heading.
- [ ] `docs/game-day-checklist.md`: row 3 drops "Within a minute of the Hub page showing" for "Once the Hub page shows"; row 23 becomes "With three tiles playing, wait 5 minutes for a guide read | All three keep playing; the read plays nothing"; row 24 becomes "During a read, look for a window or sound | None: a read opens no view"; add "Set the guide's sort to Custom in YouTube TV, wait for a read | The Hub logs fewer channels; games on hidden channels are Not in guide. Set it back to Default".
- [ ] `docs/specs/2026-10-03-guide-matched-channels-design.md` Status line: append "; how the guide is read is replaced by `docs/specs/2026-10-03-guide-direct-read-design.md`".
- [ ] `pnpm check`, then commit `docs: the guide is read with one request; glossary, ADR 0002, game-day rows follow`, with the new spec and this plan.
