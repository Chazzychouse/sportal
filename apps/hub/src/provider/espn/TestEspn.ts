import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, HashMap, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { HubConfig } from "../../HubConfig.ts"
import { Delivery, type Provider } from "../Provider.ts"
import * as Espn from "./Espn.ts"
import * as EspnEvent from "./EspnEvent.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { GameTopics } from "./GameTopics.ts"
import { Topic } from "./Topic.ts"

/**
 * ESPN live with the default Hub config, answering each league's poll with its recorded scoreboard in `scoreboards`,
 * and with FastCast that opens no socket.
 */
export function recordedEspn(scoreboards: { readonly [L in LeagueId]: string }): Layer.Layer<Provider> {
  const recorded = HttpClient.make((request) => {
    const body = request.url.includes("/nfl/") ? scoreboards.nfl : scoreboards.fbs
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
  })
  return Espn.layer.pipe(
    Layer.provide([noSocket, HubConfig.layerTest({}).pipe(Layer.orDie)]),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, recorded))
  )
}

/** A recorded ESPN site scoreboard among this adapter's fixtures. */
export function recordedScoreboard(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
}

/** Recorded NFL play entities of 2026-10-04 with these ids, by id, as a game topic's document holds them. */
export function plays(...ids: ReadonlyArray<string>) {
  return Object.fromEntries(ids.map((id) => [id, playEntities[id] ?? {}]))
}

/**
 * Every play id NE at BUF's recorded frames add. Measured once over the fixture: every play id its topic's patches add,
 * whole or one at a time (none is removed, moved, or copied), counted with
 *   zcat nfl-2026-10-04-ne-buf.frames.jsonl.gz | jq -r 'select(.kind=="change") | .body | fromjson
 *     | select(.op=="P" or .op=="R") | .pl | fromjson | .pl | fromjson | .[]
 *     | select(.path|test("^/entities/plays(/[^/]+)?$"))
 *     | if .path=="/entities/plays" then (.value|keys[]) else (.path|ltrimstr("/entities/plays/")) end' | sort -u | wc -l
 */
export const recordedPlays = 182

/**
 * NE at BUF's frames on 2026-10-04, one JSON frame a line in a gzip'd file: imported from the recording, its game
 * topic's frames and every scoreboard poll of the day, trimmed to it.
 */
export const recordedNeAtBuf = Effect.gen(function* () {
  const file = new URL("./fixtures/nfl-2026-10-04-ne-buf.frames.jsonl.gz", import.meta.url)
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
 * What ESPN says each of `recorded` said, one array of deliveries a line: a poll is its league's `Listing` (nothing,
 * when it does not decode), after which the game topics keep only those wanted at the clock's now; a frame is what
 * `GameTopics#take` gives. It approximates the provider's ordering (retention runs synchronously after each poll), for
 * the recorded-day tests; a test of `GameTopics` alone replays frames with `TestGameTopics.framesReplayed`.
 */
export const replayed = Effect.fn("TestEspn.replayed")(function* (recorded: ReadonlyArray<Recorded>) {
  return yield* Stream.fromIterable(recorded).pipe(
    Stream.mapAccumEffect(
      () => ({ topics: GameTopics.empty, games: HashMap.empty<LeagueId, ReadonlyArray<GameSnapshot>>() }),
      (state, line) =>
        Effect.map(replayedLine(state, line), ([next, deliveries]) => [next, [deliveries]] as const)
    ),
    Stream.runCollect
  )
})

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
    const [topics, deliveries] = yield* state.topics.take(line)
    return [{ ...state, topics }, deliveries] as const
  }

  const listed = yield* Effect.option(EspnEvent.listingOf(line.league, line.body))
  if (Option.isNone(listed)) return [state, noDeliveries] as const
  const games = HashMap.set(state.games, line.league, listed.value)
  const now = yield* DateTime.now
  const topics = state.topics.retainedFor([...HashMap.values(games)].flat(), now)
  return [{ topics, games }, [Delivery.Listing({ league: line.league, games: listed.value })]] as const
})

const noDeliveries: ReadonlyArray<Delivery> = []

// Opening a socket throws, so FastCast never pushes.
const noSocket = Layer.succeed(Socket.WebSocketConstructor, () => {
  throw new Error("this test opens no socket")
})

const playEntities = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))

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

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))
