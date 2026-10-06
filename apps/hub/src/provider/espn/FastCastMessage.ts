import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Data,
  DateTime,
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Struct,
  Tuple
} from "effect"
import * as Gzip from "../../Gzip.ts"

// A patch's path. On a scoreboard topic: the uid of the event it changes (`s:20~l:28~e:<id>~c:<id>`), then a JSON
// Pointer into that event, where no pointer means the whole event. On a game topic: a JSON Pointer alone, with no uid.
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

/** One JSON Patch operation on a topic's document. */
export const Patch = Schema.Union([
  Schema.Struct({ op: Schema.Literals(["add", "replace"]), path: EventPath, value: Schema.Json }),
  Schema.Struct({ op: Schema.Literal("remove"), path: EventPath }),
  Schema.Struct({ op: Schema.Literals(["copy", "move"]), path: EventPath, from: EventPath })
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
export const Message = Schema.Union([Patched, Connected, Subscribed, Checkpoint, Idle, Heartbeat])

// A message as framing reads it: an `R` or `P`'s `pl` only as far as the time it was sent.
const Framed = Message.mapMembers(
  Tuple.evolve([
    (patched) =>
      patched.mapFields(
        Struct.assign({ pl: Schema.fromJsonString(Schema.Struct({ ts: Schema.optional(Schema.Finite) })) })
      )
  ])
)

/**
 * One FastCast socket message read only as far as framing it needs, and where it goes in the feed log: its topic as
 * the frame's channel, its mid, and when FastCast sent it.
 */
export const Envelope = Schema.fromJsonString(Framed).pipe(
  Schema.decodeTo(
    Schema.Struct({
      message: Schema.toType(Framed),
      channel: Schema.UndefinedOr(Schema.String),
      sourceId: Schema.UndefinedOr(Schema.Int),
      sentAt: Schema.UndefinedOr(Schema.DateTimeUtc)
    }),
    {
      decode: SchemaGetter.transform((message) => ({
        message,
        channel: "tc" in message ? message.tc : undefined,
        sourceId: "mid" in message ? message.mid : undefined,
        sentAt:
          (message.op === "R" || message.op === "P") && message.pl.ts !== undefined
            ? DateTime.makeUnsafe(message.pl.ts)
            : undefined
      })),
      encode: SchemaGetter.forbidden(() => "A framed message is never sent again")
    }
  )
)

/** Where to open the socket, and the token it takes, as `public/websockethost` answers. */
export const Host = Schema.Struct({ ip: Schema.String, securePort: Schema.Int, token: Schema.String })

/** A scoreboard topic's whole document, as a checkpoint URL serves it; each event stays JSON, to be patched. */
const ScoreboardCheckpoint = Schema.Struct({
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

/** A game topic's whole document, ESPN's game package, as a checkpoint URL serves it: only its plays, by id. */
const GameCheckpoint = Schema.Struct({
  entities: Schema.optional(
    Schema.Struct({ plays: Schema.optional(Schema.Record(Schema.String, Schema.Json)) })
  )
})

/** The checkpoint body of a topic `owner` carries, read by its schema: a scoreboard's events, or a game's plays. */
export function checkpointOf(owner: Owner) {
  return Owner.$match(owner, {
    Scoreboard: () => Schema.fromJsonString(ScoreboardCheckpoint),
    Game: () => Schema.fromJsonString(GameCheckpoint)
  })
}

/** What a FastCast topic carries: one league's scoreboard, or one game's package. */
export type Owner = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId }
  Game: { readonly league: LeagueId; readonly game: GameId }
}>
export const Owner = Data.taggedEnum<Owner>()

/**
 * The FastCast topic of `league`'s scoreboard, or of one game's package. A college game's topic is assumed to follow
 * its scoreboard's, unverified until a live college day.
 */
export function topic(league: LeagueId, game?: GameId): string {
  const sport = league === "nfl" ? "football-nfl" : "football-college-football"
  return game === undefined ? `event-${sport}` : `gp-${sport}-${game}`
}

/** What the FastCast topic `tc` carries, when it is a scoreboard's or a game's topic. */
export function owner(tc: string): Option.Option<Owner> {
  return Arr.findFirst(LeagueId.literals, (league) => {
    const gamePrefix = topic(league, GameId.make(""))
    return tc === topic(league)
      ? Option.some(Owner.Scoreboard({ league }))
      : tc.startsWith(gamePrefix) && tc.length > gamePrefix.length
        ? Option.some(Owner.Game({ league, game: GameId.make(tc.slice(gamePrefix.length)) }))
        : Option.none()
  })
}

function inflate(compressed: Uint8Array): Effect.Effect<string, SchemaIssue.Issue> {
  return Gzip.decompress(compressed, "deflate").pipe(
    Effect.mapError(
      (cause) => new SchemaIssue.InvalidValue({ message: `Not zlib-deflated: ${String(cause)}` }, compressed)
    )
  )
}
