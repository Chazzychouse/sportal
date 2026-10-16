import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId, type GameSnapshot, Network } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import {
  type Cause,
  DateTime,
  Deferred,
  Effect,
  HashMap,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import * as Espn from "./provider/espn/Espn.ts"
import * as EspnEvent from "./provider/espn/EspnEvent.ts"
import { FastCast, Frame, Topic, type Wanted } from "./provider/espn/FastCast.ts"
import * as FastCastMessage from "./provider/espn/FastCastMessage.ts"
import { GameTopics } from "./provider/espn/GameTopics.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import { Source } from "./source/Source.ts"

/**
 * ESPN live, answering each league's poll with its recorded scoreboard in `scoreboards`,
 * and with FastCast that opens no socket.
 */
export function recordedEspn(scoreboards: {
  readonly nfl: string
  readonly fbs: string
}): Layer.Layer<Provider> {
  const recorded = HttpClient.make((request) => {
    const body = request.url.includes("/nfl/") ? scoreboards.nfl : scoreboards.fbs
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
  })
  return Espn.layer.pipe(
    Layer.provide(noSocket),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, recorded))
  )
}

/** A recorded ESPN site scoreboard among the ESPN adapter's fixtures. */
export function recordedScoreboard(name: string): string {
  return readFileSync(new URL(`./provider/espn/fixtures/${name}.json`, import.meta.url), "utf8")
}

/** Recorded NFL play entities of 2026-10-04 with these ids, by id, as a game topic's document holds them. */
export function plays(...ids: ReadonlyArray<string>) {
  return Object.fromEntries(ids.map((id) => [id, playEntities[id] ?? {}]))
}

/**
 * NE at BUF's frames on 2026-10-04, one JSON frame a line in a gzip'd file: imported from the recording, its game
 * topic's frames and every scoreboard poll of the day, trimmed to it.
 */
export const recordedNeAtBuf = Effect.gen(function* () {
  const file = new URL("./provider/espn/fixtures/nfl-2026-10-04-ne-buf.frames.jsonl.gz", import.meta.url)
  const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n")

  const recorded = lines.filter((line) => line !== "")
  return yield* Effect.forEach(recorded, (line) => recordedOf(line))
})

/**
 * A time during NE at BUF's recorded game, for its recorded day to be folded at: a poll keeps the game's topic until a
 * poll lists it final.
 */
export const duringNeAtBuf = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

/**
 * What ESPN says each of `recorded` said, in order: a poll is its league's `Listing` (nothing,
 * when it does not decode), after which the game topics keep only those wanted at the clock's now; a frame is what
 * `GameTopics#take` gives. It approximates the provider's ordering (retention runs synchronously after each poll), for
 * the recorded-day tests; a test of `GameTopics` alone replays frames with `framesReplayed`.
 */
export const replayed = Effect.fn("TestHub.replayed")(function* (recorded: ReadonlyArray<Recorded>) {
  return yield* Stream.fromIterable(recorded).pipe(
    Stream.mapAccumEffect(
      () => ({ topics: GameTopics.empty, games: HashMap.empty<LeagueId, ReadonlyArray<GameSnapshot>>() }),
      (state, line) =>
        Effect.map(replayedLine(state, line), ([next, said]) => [next, Option.toArray(said)] as const)
    ),
    Stream.runCollect
  )
})

/** NE at BUF's recorded day, replayed lazily and cached for this module instance. */
export const neAtBufDecoded = Effect.runSync(Effect.cached(Effect.flatMap(recordedNeAtBuf, replayed)))

/** A recorded day's line: a poll's body, or a FastCast frame. */
type Recorded = Frame | { readonly league: LeagueId; readonly body: string }

/** What one recorded line says, and the replay after it: the game topics, and each league's last good listing. */
const replayedLine = Effect.fnUntraced(function* (
  state: {
    readonly topics: GameTopics
    readonly games: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
  },
  line: Recorded
) {
  if (!("league" in line)) {
    const [topics, said] = yield* state.topics.take(line)
    return [{ ...state, topics }, said] as const
  }

  const listed = yield* Effect.option(EspnEvent.listingOf(line.league, line.body))
  if (Option.isNone(listed)) return [state, Option.none<Delivery>()] as const
  const games = HashMap.set(state.games, line.league, listed.value)
  const now = yield* DateTime.now
  const topics = state.topics.retainedFor([...HashMap.values(games)].flat(), now)
  return [
    { topics, games },
    Option.some(Delivery.Listing({ league: line.league, games: listed.value }))
  ] as const
})

// Opening a socket throws, so FastCast never pushes.
const noSocket = Layer.succeed(Socket.WebSocketConstructor, () => {
  throw new Error("this test opens no socket")
})

const playEntities = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./provider/espn/fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))

/** A line of the recording, as it was recorded: its way, its league or topic, whole or a change, and its mid. */
const decodeRecorded = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      source: Schema.Literals(["push", "poll"]),
      channel: Schema.String,
      kind: Schema.Literals(["whole", "change"]),
      number: Schema.optional(Schema.Int),
      body: Schema.String
    })
  )
)

/** A recorded line as the poll or the frame it is. */
const recordedOf = Effect.fnUntraced(function* (line: string) {
  const { source, channel, kind, number, body } = yield* decodeRecorded(line)
  if (source === "poll") {
    const league = yield* decodeLeague(channel)
    return { league, body } satisfies Recorded
  }

  const topic = Topic.fromTc(channel)
  const mid = Option.fromUndefinedOr(number)
  if (kind === "change") return Frame.Pushed({ topic, mid, envelope: decodeEnvelope(body) })

  const checkpointTopic = yield* Effect.fromOption(topic)
  const checkpointMid = yield* Effect.fromOption(mid)
  const document = yield* Schema.decodeEffect(FastCastMessage.Checkpoint)(body)
  return Frame.Checkpoint({ topic: checkpointTopic, mid: checkpointMid, document })
})

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)

/**
 * One open socket that answers the handshake and each subscription as FastCast does, recording each frame the client
 * sends; the test sends the rest and closes it. Each socket the client opens is this one again.
 */
export function fakeServer() {
  const listeners = new Set<{
    readonly type: string
    readonly listener: (event: Socket.WebSocketEvent) => void
  }>()
  const sent = watched<Sent>()
  const emit = (type: string, event: Socket.WebSocketEvent) =>
    [...listeners]
      .filter((entry) => entry.type === type)
      .forEach((entry) => {
        entry.listener(event)
      })
  const send = (data: object) => emit("message", { data: JSON.stringify(data) })
  const socket: Socket.WebSocketLike = {
    readyState: 1,
    addEventListener: (type, listener) => {
      listeners.add({ type, listener })
    },
    removeEventListener: (type, listener) =>
      [...listeners]
        .filter((entry) => entry.type === type && entry.listener === listener)
        .forEach((entry) => {
          listeners.delete(entry)
        }),
    close: () => {},
    send: (data) => {
      const frame = decodeSent(String(data))
      if (frame.op === "C") send({ hbi: 30, rc: 200, sid: "sid-1", op: "C" })
      if (frame.op === "S") send({ rc: 200, sid: frame.sid, tc: frame.tc, op: "S" })
      // Recorded after the answer, so a test waiting on this frame sends what follows after it.
      sent.add(frame)
    }
  }
  return {
    socket,
    sent,
    send,
    sendText: (data: string) => emit("message", { data }),
    close: (code: number) => emit("close", { code, reason: "" })
  }
}

/**
 * Values as they arrive, and `until`, which waits for the first moment they satisfy a condition and gives them as
 * they are then.
 */
export function watched<A>() {
  const values: Array<A> = []
  const waiting = new Set<{
    readonly satisfied: (all: ReadonlyArray<A>) => boolean
    readonly done: Deferred.Deferred<void>
  }>()
  return {
    add: (value: A) => {
      values.push(value)
      ;[...waiting]
        .filter((waiter) => waiter.satisfied(values))
        .forEach((waiter) => {
          waiting.delete(waiter)
          Deferred.doneUnsafe(waiter.done, Effect.void)
        })
    },
    all: (): ReadonlyArray<A> => [...values],
    until: (satisfied: (all: ReadonlyArray<A>) => boolean): Effect.Effect<ReadonlyArray<A>> =>
      Effect.suspend(() => {
        if (satisfied(values)) return Effect.succeed([...values])
        const done = Deferred.makeUnsafe<void>()
        waiting.add({ satisfied, done })
        return Deferred.await(done).pipe(Effect.map(() => [...values]))
      })
  }
}

/** Whether `tc` has been subscribed to at least `times` times among what a client `sent`. */
export function subscribed(tc: string, times: number) {
  return (sent: ReadonlyArray<Sent>) =>
    sent.filter((frame) => frame.op === "S" && frame.tc === tc).length >= times
}

/**
 * Runs FastCast's frames over `server` in a fiber of its own, told to follow the NFL game `main` until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
export function nflFrames(server: ReturnType<typeof fakeServer>) {
  return framesOver(fastCastHost(server))
}

/**
 * Runs FastCast's frames over `host` in a fiber of its own, told to follow the NFL game `main` until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
export function framesOver(host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void>()
    const frames = watched<Frame>()
    const wanted = yield* SubscriptionRef.make(wantedOf([main, "AwaitingCheckpoint"]))
    const running = yield* FastCast

    yield* running.follow(SubscriptionRef.changes(wanted)).pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    const want = (...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>) =>
      SubscriptionRef.set(wanted, wantedOf(...entries))
    return { ended, frames, want }
  }).pipe(Effect.provide(FastCast.layer.pipe(Layer.provide(host))))
}

/** ESPN's host, whose every socket is already closed when it opens, and each address a socket was opened at. */
export function closedSockets() {
  const opened = watched<string>()
  const closed: Socket.WebSocketLike = {
    readyState: 3,
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    send: () => {}
  }
  const host = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, (url) => {
      opened.add(url)
      return closed
    })
  )
  return { opened, host }
}

/** The first game of the recorded checkpoint, live: FastCast follows its topic from the start. */
export const firstGame = "401872971"

/** The NFL game topic followed from the start, and any NFL game's. */
export const gameOf = (game: string) => new Topic({ league: "nfl", game: GameId.make(game) })
export const main = gameOf(firstGame)
export const mainTc = gameTopic(firstGame)

export function gameTopic(game: string) {
  return `gp-football-nfl-${game}`
}

/** The recorded game package's checkpoint, at `mid`. */
export function checkpointMessage(mid: number) {
  return { op: "H", tc: mainTc, mid, pl: `https://checkpoint.test/${mid}` }
}

/** A `P` at `mid` whose patches are base64, but not zlib-deflated. */
export function undecodablePatchMessage(mid: number) {
  const pl = Buffer.from("not deflated").toString("base64")
  return { op: "P", tc: mainTc, mid, pl: JSON.stringify({ ts: 1791136341731, pl }) }
}

export const ariAtNygPlays = "gp-football-nfl-401872966"
export const neAtBufPlays = "gp-football-nfl-401872971"

// Recorded from ESPN on 2026-10-04 on BUF at NE's game topic: the two plays its messages 819–822 patch, as they stood
// after message 818, and those messages as the recorder kept them. Message 819 opens with a `move` outside the plays.
export const moveRecording = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      checkpoint: Schema.Struct({ mid: Schema.Int, body: Schema.Json }),
      messages: Schema.Array(
        Schema.Struct({
          op: Schema.String,
          tc: Schema.String,
          mid: Schema.Int,
          ts: Schema.Finite,
          pl: Schema.String
        })
      )
    })
  )
)(readFileSync(new URL("./provider/espn/fixtures/nfl-gp-move-2026-10-04.json", import.meta.url), "utf8"))

const checkpointBody = JSON.stringify(moveRecording.checkpoint.body)

/** The recorded checkpoint's document, as a checkpoint frame holds it. */
export const checkpointDocument = Schema.decodeSync(FastCastMessage.Checkpoint)(checkpointBody)

/** A checkpoint frame of `document` on `tc`, at `mid`. */
export function checkpoint(tc: string, mid: number, document: unknown): Frame {
  const decoded = Schema.decodeSync(FastCastMessage.Checkpoint)(JSON.stringify(document))
  return Frame.Checkpoint({ topic: topicNamed(tc), mid, document: decoded })
}

/** A `P` on `tc`, its patches sent as an array, one of the three ways FastCast spells them. */
export function message(tc: string, mid: number, patches: ReadonlyArray<object>): Frame {
  const pl = JSON.stringify({ ts: 1791136341731, pl: patches })
  return Frame.Pushed({
    topic: Topic.fromTc(tc),
    mid: Option.some(mid),
    envelope: decodeEnvelope(JSON.stringify({ op: "P", tc, mid, pl }))
  })
}

/** The topic `tc` names; a test names only real ones. */
export function topicNamed(tc: string): Topic {
  return Option.getOrThrow(Topic.fromTc(tc))
}

/** NE at BUF's game topic synced at the recorded checkpoint, message 818. */
export function neAtBufCheckpoint(): Frame {
  return checkpoint(neAtBufPlays, moveRecording.checkpoint.mid, moveRecording.checkpoint.body)
}

/** A patch and an idle message on NE at BUF's game topic, before any checkpoint. */
export function beforeAnyCheckpoint(): ReadonlyArray<Frame> {
  const idle = Frame.Pushed({
    topic: Topic.fromTc(neAtBufPlays),
    mid: Option.some(820),
    envelope: decodeEnvelope(JSON.stringify({ op: "I", tc: neAtBufPlays, mid: 820 }))
  })
  return [textReplaced(819), idle]
}

/** A patch on NE at BUF's game topic that sets its penalty play's text. */
export function textReplaced(mid: number) {
  return message(neAtBufPlays, mid, [
    { op: "replace", path: "/entities/plays/401872971792/text", value: "Corrected" }
  ])
}

/** A patch on NE at BUF's game topic that will not apply: it has no such play. */
export function unapplicablePatch(mid: number) {
  return message(neAtBufPlays, mid, [
    { op: "replace", path: "/entities/plays/no-such-play/text", value: "Corrected" }
  ])
}

/** A message on NE at BUF's game topic that does not decode: FastCast sends no `test` op. */
export function undecodablePatch(mid: number) {
  return message(neAtBufPlays, mid, [{ op: "test", path: "/entities/plays", value: {} }])
}

/** BUF at NE's recorded checkpoint and the messages after it, as FastCast frames. */
export function moveRecordingFrames(): ReadonlyArray<Frame> {
  const messages = moveRecording.messages.map(
    ({ op, tc, mid, ts, pl }): Frame =>
      Frame.Pushed({
        topic: Topic.fromTc(tc),
        mid: Option.some(mid),
        envelope: decodeEnvelope(JSON.stringify({ op, tc, mid, pl: JSON.stringify({ ts, pl }) }))
      })
  )
  return [neAtBufCheckpoint(), ...messages]
}

/** A frame a FastCast client sends: its op, and the session and topic it names, if any. */
export const Sent = Schema.Struct({
  op: Schema.String,
  sid: Schema.optionalKey(Schema.String),
  tc: Schema.optionalKey(Schema.String)
})
export type Sent = typeof Sent.Type

/** A wanted set of `entries`. */
function wantedOf(...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>): Wanted {
  return HashMap.fromIterable(entries)
}

function fastCastHost(server: ReturnType<typeof fakeServer>) {
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
  )
}

// FastCast's host lookup, and any checkpoint, which is the recorded one, except a missing one, one that is not a game
// package, one that never comes, and a recorded or missing one that comes after 5 s.
const espn = HttpClient.make((request) => {
  const url = new URL(request.url)
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      url.pathname.endsWith("websockethost")
        ? new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
        : url.pathname === "/missing" || url.pathname === "/slow-missing"
          ? new Response("Not Found", { status: 404 })
          : url.pathname === "/garbled"
            ? new Response(JSON.stringify({ entities: "not a game package" }))
            : new Response(checkpointBody)
    )
  ).pipe(
    Effect.andThen((response) =>
      url.pathname === "/hang"
        ? Effect.never
        : url.pathname === "/slow" || url.pathname === "/slow-missing"
          ? Effect.sleep("5 seconds").pipe(Effect.as(response))
          : Effect.succeed(response)
    )
  )
})

const decodeSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent))

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))

/** What GameTopics gives for each frame, one per frame. */
export const framesReplayed = Effect.fn("TestHub.framesReplayed")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Stream.fromIterable(frames).pipe(
    Stream.mapAccumEffect(
      () => GameTopics.empty,
      (topics, frame) => Effect.map(topics.take(frame), ([next, said]) => [next, [said]] as const)
    ),
    Stream.runCollect
  )
})

/** The game topics after frames, from none. */
export const topicsAfter = Effect.fn("TestHub.topicsAfter")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Effect.reduce(
    frames,
    () => GameTopics.empty,
    (topics, frame) => Effect.map(topics.take(frame), ([next]) => next)
  )
})

/**
 * The games the provided `Provider`'s first listing of `league` lists. It waits on the live clock for at most 2
 * seconds, so a provider whose first poll of `league` failed fails the test, saying so, rather than hanging it.
 */
export const listedBy = Effect.fn("TestHub.listedBy")(function* (league: LeagueId) {
  const provider = yield* Provider
  const listing = yield* provider.deliveries.pipe(
    Stream.filter(Delivery.$is("Listing")),
    Stream.filter((delivery) => delivery.league === league),
    Stream.runHead,
    Effect.raceFirst(
      Effect.sleep("2 seconds").pipe(
        TestClock.withLive,
        Effect.andThen(
          Effect.die(new Error(`the provider delivered no listing of ${league} within 2 seconds`))
        )
      )
    )
  )

  return Option.match(listing, { onNone: () => [], onSome: ({ games }) => games })
})

/** YouTube TV's guide as it was read on 2026-10-03. */
export const recordedGuide = readFileSync(
  new URL("./source/youtube-tv/fixtures/guide-2026-10-03T2024Z.json", import.meta.url),
  "utf8"
)

/** When the recorded guide was read, in epoch milliseconds for the test clock. */
export const recordedAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))

/** Reads the recorded guide on the test clock at the moment it was recorded. */
export const readRecordedGuide = Effect.gen(function* () {
  yield* TestClock.setTime(recordedAt)
  const source = yield* Source

  yield* source.readGuide(recordedGuide)
})

/** A guide response with one row, News 3 airing Ohio State at Iowa, whose live id is `videoId`. */
export function oneRowGuide(videoId: string) {
  const row = {
    station: {
      epgStationRenderer: {
        stationId: "UCPc5PkgTSfcJCi3-dJyg3Tg",
        icon: { accessibility: { accessibilityData: { label: "News 3" } } }
      }
    },
    navigationEndpoint: { watchEndpoint: { videoId } },
    airings: [
      {
        epgAiringRenderer: {
          beginTimeMs: String(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T19:35:00Z"))),
          endTimeMs: String(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T23:00:00Z"))),
          title: { runs: [{ text: "Ohio State at Iowa" }] }
        }
      }
    ]
  }
  return JSON.stringify({
    contents: {
      epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [{ epgRowRenderer: row }] } } }
    }
  })
}

/** Each game's availability at the clock's now, as the provided `Source` gives it. */
export const availabilityNow = Effect.gen(function* () {
  const source = yield* Source
  const now = yield* DateTime.now

  const availabilityOf = yield* source.availability
  return (game: GameSnapshot) => availabilityOf(game, now)
})

/** News 3's live address, recorded from YouTube TV's live guide on 2026-10-03. */
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"

/** Ohio State at Iowa, live on CBS, which the recorded guide has on News 3. */
export const ohioStateAtIowa = snapshot({
  status: "live",
  startsAt: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
  away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
  home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
  broadcasts: [broadcast("CBS")]
})

/** Carried on News 3, at its recorded live address. */
export const onNews3: ChannelAvailability = {
  _tag: "Carried",
  channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
}

/** The frames a test offers a provider faked with `Provider.layerTest`, one at a time. */
export type Frames = Queue.Queue<ReadonlyArray<Delivery>, Cause.Done>

/**
 * Offers one frame that says only `delivery`, returning once the Director has taken it: the second empty frame is
 * accepted only once the Director has pulled the first, which it does only after taking `delivery`.
 */
export const offered = Effect.fnUntraced(function* (frames: Frames, delivery: Delivery) {
  yield* Queue.offer(frames, [delivery])
  yield* Queue.offer(frames, [])
  yield* Queue.offer(frames, [])
})

/** Alabama at Mississippi State, live and scoreless on ESPN. */
export const alaAtMsst = snapshot({
  id: GameId.make("401856707"),
  status: "live",
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: [broadcast(Network.make("ESPN"))]
})

/** `alaAtMsst` in `period`. */
export function alaAtMsstInPeriod(period: number) {
  return snapshot({ ...alaAtMsst, period })
}

/** Delivers the fbs listing of `alaAtMsst`, so the Director has its first games, and moves on 250 ms for it to settle. */
export const alaAtMsstListed = Effect.fnUntraced(function* (frames: Frames) {
  yield* offered(frames, Delivery.Listing({ league: "fbs", games: [alaAtMsst] }))
  yield* TestClock.adjust("250 millis")
})
