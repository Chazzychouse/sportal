import { type Broadcast, GameId, GameSnapshot, Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Team, TeamId } from "@sportal/domain/Team"
import { Effect, Schema, SchemaGetter, SchemaIssue, Stream } from "effect"
import * as EspnSnapshot from "./EspnSnapshot.ts"

// A patch's path: the uid of the event it changes (`s:20~l:28~e:<id>~c:<id>`), then a JSON Pointer into that event.
// No pointer means the whole event.
const EventPath = Schema.String.pipe(
  Schema.decodeTo(Schema.Struct({ uid: Schema.String, pointer: Schema.String }), {
    decode: SchemaGetter.transform((path) => {
      const slash = path.indexOf("/")
      return slash === -1
        ? { uid: path, pointer: "" }
        : { uid: path.slice(0, slash), pointer: path.slice(slash) }
    }),
    encode: SchemaGetter.transform(({ uid, pointer }) => `${uid}${pointer}`)
  })
)

/** One JSON Patch operation on one event of a topic's document. */
export const Patch = Schema.Union([
  Schema.Struct({ op: Schema.Literals(["add", "replace"]), path: EventPath, value: Schema.Json }),
  Schema.Struct({ op: Schema.Literal("remove"), path: EventPath }),
  Schema.Struct({ op: Schema.Literal("copy"), path: EventPath, from: EventPath })
])

const Patches = Schema.Array(Patch)

// The inner `pl` of an `R` or `P`: base64 of zlib-deflated JSON, JSON text, or the patches themselves.
const PatchesPayload = Schema.Union([
  Patches,
  Schema.fromJsonString(Patches),
  Schema.Uint8ArrayFromBase64.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect(inflate),
      encode: SchemaGetter.forbidden(() => "FastCast patches are never compressed again")
    }),
    Schema.decodeTo(Schema.fromJsonString(Patches))
  )
])

// The `pl` of an `R` or `P` is JSON text of `{ ts, pl }`.
const PatchedPayload = Schema.fromJsonString(Schema.Struct({ pl: PatchesPayload })).pipe(
  Schema.decodeTo(Schema.toType(Patches), {
    decode: SchemaGetter.transform(({ pl }) => pl),
    encode: SchemaGetter.transform((pl) => ({ pl }))
  })
)

const Connected = Schema.Struct({ op: Schema.Literal("C"), sid: Schema.String })
const Subscribed = Schema.Struct({ op: Schema.Literal("S"), tc: Schema.String })
// `pl` is the URL of the topic's whole document as of `mid`.
const Checkpoint = Schema.Struct({
  op: Schema.Literal("H"),
  tc: Schema.String,
  mid: Schema.Int,
  pl: Schema.String
})
const Patched = Schema.Struct({
  op: Schema.Literals(["R", "P"]),
  tc: Schema.String,
  mid: Schema.Int,
  pl: PatchedPayload
})
const Idle = Schema.Struct({ op: Schema.Literal("I"), tc: Schema.String, mid: Schema.Int })
const Heartbeat = Schema.Struct({ op: Schema.Literal("B") })

/** One FastCast socket message. */
export const Message = Schema.Union([Connected, Subscribed, Checkpoint, Patched, Idle, Heartbeat])

/** A topic's whole document, as a checkpoint URL serves it; each event stays JSON, to be patched. */
export const CheckpointDocument = Schema.Struct({
  sports: Schema.Array(
    Schema.Struct({
      leagues: Schema.Array(
        Schema.Struct({
          events: Schema.Array(
            Schema.StructWithRest(Schema.Struct({ uid: Schema.String }), [
              Schema.Record(Schema.String, Schema.Json)
            ])
          )
        })
      )
    })
  )
})

// FastCast's competitor is the team itself, with its score and rank beside its names.
const Competitor = Schema.Struct({
  id: Schema.String,
  homeAway: Schema.Literals(["home", "away"]),
  score: Schema.optional(EspnSnapshot.Score),
  abbreviation: Schema.String,
  displayName: Schema.String,
  location: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  rank: Schema.optional(Schema.Int)
})

/** One event of a `league` topic's document, read as a `GameSnapshot`. */
export function Event(league: LeagueId) {
  return Schema.Struct({
    id: Schema.String,
    date: Schema.DateTimeUtcFromString,
    fullStatus: Schema.Struct({ period: Schema.Int, displayClock: Schema.String, type: EspnSnapshot.Status }),
    competitors: Schema.Array(Competitor),
    broadcasts: Schema.optional(
      Schema.Array(Schema.Struct({ type: Schema.String, shortName: Schema.String }))
    ),
    situation: Schema.optional(EspnSnapshot.Situation)
  }).pipe(
    Schema.decodeTo(Schema.toType(GameSnapshot), {
      decode: SchemaGetter.transformEffect((event) => {
        const home = event.competitors.find((competitor) => competitor.homeAway === "home")
        const away = event.competitors.find((competitor) => competitor.homeAway === "away")
        return home === undefined || away === undefined
          ? Effect.fail(
              new SchemaIssue.InvalidValue({ message: "An event needs a home and an away team" }, event)
            )
          : Effect.succeed(
              new GameSnapshot({
                id: GameId.make(event.id),
                league,
                kickoff: event.date,
                status: event.fullStatus.type,
                period: event.fullStatus.period,
                clock: event.fullStatus.displayClock,
                home: side(league, home),
                away: side(league, away),
                broadcasts: (event.broadcasts ?? []).flatMap(broadcast),
                situation:
                  event.situation === undefined
                    ? undefined
                    : EspnSnapshot.situation(league, event.situation, home.id)
              })
            )
      }),
      encode: SchemaGetter.forbidden(() => "A GameSnapshot cannot be encoded back to a FastCast event")
    })
  )
}

function inflate(compressed: Uint8Array): Effect.Effect<string, SchemaIssue.Issue> {
  return Stream.fromReadableStream({
    evaluate: () =>
      Stream.toReadableStream(Stream.make(compressed)).pipeThrough(new DecompressionStream("deflate")),
    onError: (cause) =>
      new SchemaIssue.InvalidValue({ message: `Not zlib-deflated: ${String(cause)}` }, compressed)
  }).pipe(Stream.decodeText, Stream.mkString)
}

// FastCast has no short display name: Ingest replaces every pushed game's names with the poll's.
function side(league: LeagueId, competitor: typeof Competitor.Type) {
  return {
    team: new Team({
      id: TeamId.make(`${league}:${competitor.id}`),
      abbreviation: competitor.abbreviation,
      name: competitor.displayName,
      location: competitor.location ?? competitor.displayName,
      shortName: competitor.displayName,
      logo: competitor.logo
    }),
    score: competitor.score ?? 0,
    // ESPN ranks an unranked team 99.
    ranking: competitor.rank === undefined || competitor.rank > 25 ? undefined : competitor.rank
  }
}

/** A TV or streaming broadcast; any other kind is one no source plays. */
function broadcast({
  type,
  shortName
}: {
  readonly type: string
  readonly shortName: string
}): Array<Broadcast> {
  const medium = type === "TV" ? "tv" : type === "Streaming" ? "streaming" : undefined
  return medium === undefined ? [] : [{ network: Network.make(shortName), medium }]
}
