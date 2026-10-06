import { type Effect, Schema, SchemaGetter, SchemaIssue, Stream } from "effect"

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
export const Message = Schema.Union([Connected, Subscribed, Checkpoint, Patched, Idle, Heartbeat])

/** One FastCast socket message read only as far as framing it needs: its patches stay text, with the time sent. */
export const Envelope = Schema.Union([
  Connected,
  Subscribed,
  Checkpoint,
  Schema.Struct({
    op: Schema.Literals(["R", "P"]),
    tc: Schema.String,
    mid: Schema.Int,
    pl: Schema.fromJsonString(Schema.Struct({ ts: Schema.optional(Schema.Number) }))
  }),
  Idle,
  Heartbeat
])

/** Where to open the socket, and the token it takes, as `public/websockethost` answers. */
export const Host = Schema.Struct({ ip: Schema.String, securePort: Schema.Int, token: Schema.String })

/** A scoreboard topic's whole document, as a checkpoint URL serves it; each event stays JSON, to be patched. */
export const ScoreboardCheckpoint = Schema.Struct({
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
export const GameCheckpoint = Schema.Struct({
  entities: Schema.optional(
    Schema.Struct({ plays: Schema.optional(Schema.Record(Schema.String, Schema.Json)) })
  )
})

function inflate(compressed: Uint8Array): Effect.Effect<string, SchemaIssue.Issue> {
  return Stream.fromReadableStream({
    evaluate: () =>
      Stream.toReadableStream(Stream.make(compressed)).pipeThrough(new DecompressionStream("deflate")),
    onError: (cause) =>
      new SchemaIssue.InvalidValue({ message: `Not zlib-deflated: ${String(cause)}` }, compressed)
  }).pipe(Stream.decodeText, Stream.mkString)
}
