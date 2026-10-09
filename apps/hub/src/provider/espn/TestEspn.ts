import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { HubConfig } from "../../HubConfig.ts"
import type { Provider } from "../Provider.ts"
import * as Espn from "./Espn.ts"
import { EspnState } from "./EspnState.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { topicOf } from "./Topic.ts"

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

  const frames = lines.filter((line) => line !== "")
  return yield* Effect.forEach(frames, (line) => frameOf(line))
})

/**
 * A time during NE at BUF's recorded game, for its recorded day to be folded at: a poll keeps the game's topic until a
 * poll lists it final.
 */
export const duringNeAtBuf = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

/** What ESPN's fold says each of `frames` said, from an empty state. */
export const decodedFrames = Effect.fn("TestEspn.decodedFrames")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Stream.fromIterable(frames).pipe(
    Stream.mapAccumEffect(
      () => EspnState.empty,
      (state, frame) =>
        Effect.map(
          state.take(frame, LeagueId.literals),
          ([next, deliveries]) => [next, [deliveries]] as const
        )
    ),
    Stream.runCollect
  )
})

/** ESPN's state after `frames`, from an empty one. */
export const stateAfter = Effect.fn("TestEspn.stateAfter")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Effect.reduce(
    frames,
    () => EspnState.empty,
    (state, frame) => Effect.map(state.take(frame, LeagueId.literals), ([next]) => next)
  )
})

// Opening a socket throws, so FastCast never pushes.
const noSocket = Layer.succeed(Socket.WebSocketConstructor, () => {
  throw new Error("this test opens no socket")
})

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

/** A recorded line as the frame it is. */
const frameOf = Effect.fnUntraced(function* (line: string) {
  const { source, channel, kind, number, body } = yield* decodeRecorded(line)
  if (source === "poll") {
    const league = yield* decodeLeague(channel)
    return Frame.Polled({ league, body })
  }

  const topic = topicOf(channel)
  const mid = Option.fromUndefinedOr(number)
  if (kind === "change") return Frame.Pushed({ topic, mid, envelope: decodeEnvelope(body) })

  const checkpointTopic = yield* Effect.fromOption(topic)
  const checkpointMid = yield* Effect.fromOption(mid)
  const document = yield* Schema.decodeEffect(FastCastMessage.Checkpoint(checkpointTopic))(body)
  return Frame.Checkpoint({ topic: checkpointTopic, mid: checkpointMid, document })
})

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))
