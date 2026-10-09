import type { GameId } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Data,
  Effect,
  HashMap,
  JsonPatch,
  JsonPointer,
  Option,
  Record,
  Result,
  Schema
} from "effect"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { Topic } from "./Topic.ts"

/**
 * The FastCast topics' documents after `frame`, and what it changed: a scoreboard topic's touched events (every event,
 * on a checkpoint), or all of a game topic's plays, by id, when they changed. A topic is synced by its checkpoint
 * frame and moved on by each message after it. A missed message, a patch that will not apply, or a message that does
 * not decode on a synced topic sends only that topic back to waiting for a checkpoint, and the change is a `Reset` of
 * it. A checkpoint that does not decode leaves its topic waiting, and asks for nothing: the live feed already followed
 * it again. A message of an op it does not know is skipped. Fails only when any other frame does not decode, leaving
 * the documents as they were.
 */
export const advance = Effect.fnUntraced(function* (
  documents: Documents,
  frame: Frame
): Effect.fn.Return<Advanced, Schema.SchemaError> {
  return yield* Frame.$match(frame, {
    Polled: () => Effect.succeed(unchanged(documents)),
    Checkpoint: (checkpointed) => synced(documents, checkpointed),
    Pushed: (pushed) => moveOn(documents, pushed)
  })
})

/** No topic has a document yet. */
export const empty: Documents = HashMap.empty()

/** Whether `topic`'s document is synced: its checkpoint read, and every message since applied. */
export function isSynced(documents: Documents, topic: Topic): boolean {
  return Option.exists(HashMap.get(documents, topic), Document.$is("Synced"))
}

/**
 * Where one topic's document is: waiting for a checkpoint, or synced as of a message. A scoreboard topic's document is
 * its events by uid; a game topic's is its plays by id, at `gamePlays`.
 */
type Document = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Synced: { readonly mid: number; readonly document: Schema.Json }
}>
const Document = Data.taggedEnum<Document>()

type Documents = HashMap.HashMap<Topic, Document>

/** The documents after a frame, and what it changed. */
interface Advanced {
  readonly documents: Documents
  readonly change: Option.Option<Change>
}

/** The documents after a frame that changed nothing. */
function unchanged(documents: Documents): Advanced {
  return { documents, change: Option.none() }
}

/**
 * What a frame changed: a scoreboard topic's touched events, a game topic's whole list of plays, by id, or a topic sent
 * back to waiting for a checkpoint, and why.
 */
export type Change = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId; readonly events: ReadonlyArray<Schema.Json> }
  Game: {
    readonly league: LeagueId
    readonly game: GameId
    readonly plays: Readonly<Record<string, Schema.Json>>
  }
  Reset: { readonly topic: Topic; readonly detail: string }
}>
export const Change = Data.taggedEnum<Change>()

const synced = Effect.fnUntraced(function* (
  documents: Documents,
  frame: Extract<Frame, { readonly _tag: "Checkpoint" }>
): Effect.fn.Return<Advanced> {
  const loaded = yield* checkpoint(frame).pipe(Effect.result)
  if (Result.isFailure(loaded)) {
    return unchanged(HashMap.set(documents, frame.topic, Document.AwaitingCheckpoint()))
  }

  const document = loaded.success
  return {
    documents: HashMap.set(documents, frame.topic, Document.Synced({ mid: frame.mid, document })),
    change: Option.some(changeOf(frame.topic, document, Option.none()))
  }
})

const moveOn = Effect.fnUntraced(function* (
  documents: Documents,
  frame: Extract<Frame, { readonly _tag: "Pushed" }>
): Effect.fn.Return<Advanced, Schema.SchemaError> {
  const decoded = yield* decodeMessage(frame.body).pipe(Effect.result)
  if (Result.isFailure(decoded)) return yield* undecoded(documents, frame, decoded.failure)

  const message = decoded.success
  if (Option.isNone(frame.topic) || !movesOn(message)) return unchanged(documents)

  return yield* moved(documents, frame.topic.value, message)
})

const checkpoint = Effect.fnUntraced(function* (frame: Extract<Frame, { readonly _tag: "Checkpoint" }>) {
  const body = yield* Schema.decodeEffect(FastCastMessage.Checkpoint(frame.topic))(frame.body)

  const document: Schema.Json =
    "sports" in body
      ? Object.fromEntries(
          body.sports.flatMap((sport) =>
            sport.leagues.flatMap((league) => league.events.map((event) => [event.uid, event] as const))
          )
        )
      : JsonPatch.apply([{ op: "add", path: gamePlays.pointer, value: body.entities?.plays ?? {} }], {
          entities: {}
        })
  return document
})

/** Where a game topic's plays are in its document. */
const gamePlays = { pointer: "/entities/plays", path: ["entities", "plays"] } as const

/** What a topic's document says: the events `touched` names (all of them when none), or its whole list of plays. */
function changeOf(
  topic: Topic,
  document: Schema.Json,
  touched: Option.Option<ReadonlyArray<string>>
): Change {
  return Topic.$match(topic, {
    Scoreboard: ({ league }) =>
      Change.Scoreboard({
        league,
        events: Option.match(touched, {
          onNone: () => Record.values(objectAt(document, [])),
          onSome: (uids) => uids.flatMap((uid) => Option.toArray(valueAt(document, [uid])))
        })
      }),
    Game: ({ league, game }) => Change.Game({ league, game, plays: objectAt(document, gamePlays.path) })
  })
}

/** The documents after a message on a topic: a missed one, or a patch that will not apply, resets the topic. */
const moved = Effect.fnUntraced(function* (
  documents: Documents,
  topic: Topic,
  message: Extract<typeof FastCastMessage.Message.Type, { readonly op: "R" | "P" | "I" }>
): Effect.fn.Return<Advanced> {
  const current = Option.getOrElse(HashMap.get(documents, topic), () => Document.AwaitingCheckpoint())
  if (Document.$is("AwaitingCheckpoint")(current)) return unchanged(documents)

  const { mid, document } = current
  if (mid + 1 !== message.mid) {
    return reset(documents, topic, `message ${message.mid} came after ${mid}`)
  }

  const patches = message.op === "I" ? [] : relevant(topic, message.pl)
  const applied = yield* Effect.reduce(
    patches,
    () => document,
    (patchedSoFar, patch) => patched(patchedSoFar, topic, patch)
  ).pipe(Effect.result)
  if (Result.isFailure(applied)) return reset(documents, topic, applied.failure)

  const next = applied.success
  const synced = HashMap.set(documents, topic, Document.Synced({ mid: message.mid, document: next }))
  const touched = Topic.$is("Scoreboard")(topic)
    ? Option.some(Arr.dedupe(patches.map((patch) => patch.path.uid)))
    : Option.none()
  return {
    documents: synced,
    change: patches.length === 0 ? Option.none() : Option.some(changeOf(topic, next, touched))
  }
})

/** On a game topic, only the patches inside its plays: the rest of ESPN's game package is not kept. */
function relevant(
  topic: Topic,
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): ReadonlyArray<typeof FastCastMessage.Patch.Type> {
  const inPlays = (path: { readonly pointer: string }) =>
    path.pointer === gamePlays.pointer || path.pointer.startsWith(`${gamePlays.pointer}/`)
  return Topic.$is("Scoreboard")(topic)
    ? patches
    : patches.filter((patch) => inPlays(patch.path) && (!("from" in patch) || inPlays(patch.from)))
}

/** The documents with `topic` sent back to waiting for its checkpoint, and the reset that changed, for `detail`. */
function reset(documents: Documents, topic: Topic, detail: string): Advanced {
  return {
    documents: HashMap.set(documents, topic, Document.AwaitingCheckpoint()),
    change: Option.some(Change.Reset({ topic, detail }))
  }
}

/**
 * The document with `patch` applied. On a scoreboard topic the path's uid is the document's first token, and a path
 * with no pointer adds, replaces, or removes the whole event; removing an event the document lacks changes nothing.
 * `JsonPatch` has no `copy` or `move`: a copy is an add of the value read at `from`, a move a remove of `from` then
 * that add.
 */
function patched(
  document: Schema.Json,
  topic: Topic,
  patch: typeof FastCastMessage.Patch.Type
): Effect.Effect<Schema.Json, string> {
  const pointer = ({ uid, pointer }: { readonly uid: string; readonly pointer: string }) =>
    Topic.$is("Scoreboard")(topic) ? `/${JsonPointer.escapeToken(uid)}${pointer}` : pointer
  if ("from" in patch) {
    return Option.match(valueAt(document, tokens(pointer(patch.from))), {
      onNone: () => Effect.fail(`${described(patch)}: nothing at ${patch.from.uid}${patch.from.pointer}`),
      onSome: (value) =>
        applied(
          document,
          [
            ...(patch.op === "move" ? [{ op: "remove" as const, path: pointer(patch.from) }] : []),
            { op: "add", path: pointer(patch.path), value }
          ],
          patch
        )
    })
  }
  if (patch.op === "remove") {
    const wholeEventMissing =
      Topic.$is("Scoreboard")(topic) &&
      patch.path.pointer === "" &&
      Option.isNone(valueAt(document, [patch.path.uid]))
    return wholeEventMissing
      ? Effect.succeed(document)
      : applied(document, [{ op: "remove", path: pointer(patch.path) }], patch)
  }
  // A whole event replaced is set, whether or not the document had it.
  const op = patch.op === "replace" && patch.path.pointer === "" ? "add" : patch.op
  return applied(document, [{ op, path: pointer(patch.path), value: patch.value }], patch)
}

function applied(
  document: Schema.Json,
  operations: JsonPatch.JsonPatch,
  patch: typeof FastCastMessage.Patch.Type
): Effect.Effect<Schema.Json, string> {
  // JsonPatch.apply throws on an operation it cannot apply, and Effect has no variant that does not.
  return Effect.try({
    try: () => JsonPatch.apply(operations, document),
    catch: (cause) => `${described(patch)}: ${String(cause)}`
  })
}

function described(patch: typeof FastCastMessage.Patch.Type): string {
  return `${patch.op} at ${patch.path.uid}${patch.path.pointer}`
}

function tokens(pointer: string): ReadonlyArray<string> {
  return pointer.split("/").slice(1).map(JsonPointer.unescapeToken)
}

function valueAt(json: Schema.Json, path: ReadonlyArray<string>): Option.Option<Schema.Json> {
  return path.reduce(
    (at: Option.Option<Schema.Json>, token) => Option.flatMap(at, (value) => child(value, token)),
    Option.some(json)
  )
}

function child(value: Schema.Json, token: string): Option.Option<Schema.Json> {
  if (Arr.isArray<Schema.Json>(value)) {
    return /^(0|[1-9]\d*)$/.test(token) ? Arr.get(value, Number(token)) : Option.none()
  }
  return typeof value === "object" && value !== null
    ? Record.get<string, Schema.Json>(value, token)
    : Option.none()
}

function objectAt(json: Schema.Json, path: ReadonlyArray<string>): Readonly<Record<string, Schema.Json>> {
  return Option.match(valueAt(json, path), {
    onNone: () => ({}),
    onSome: (value) =>
      typeof value === "object" && value !== null && !Arr.isArray<Schema.Json>(value) ? value : {}
  })
}

/**
 * The documents after a message that does not decode: one of an unknown op is skipped, and a patch or idle message
 * on a synced topic resets that topic, since its mids can no longer be followed. Any other fails with `error`.
 */
function undecoded(
  documents: Documents,
  frame: Extract<Frame, { readonly _tag: "Pushed" }>,
  error: Schema.SchemaError
): Effect.Effect<Advanced, Schema.SchemaError> {
  return Option.match(decodeKnownOp(frame.body), {
    onNone: () => Effect.succeed(unchanged(documents)),
    onSome: (known) =>
      Option.match(frame.topic, {
        onNone: () => Effect.fail(error),
        onSome: (topic) =>
          movesOn(known) && Option.exists(HashMap.get(documents, topic), Document.$is("Synced"))
            ? Effect.succeed(
                reset(
                  documents,
                  topic,
                  `message ${Option.getOrUndefined(frame.mid)} does not decode: ${error.message}`
                )
              )
            : Effect.fail(error)
      })
  })
}

/** A replace, a patch, or an idle: the messages that move a topic's document on. */
function movesOn<M extends { readonly op: string }>(
  message: M
): message is Extract<M, { readonly op: "R" | "P" | "I" }> {
  return message.op === "R" || message.op === "P" || message.op === "I"
}

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(FastCastMessage.Message))

const decodeKnownOp = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union(FastCastMessage.Message.members.map((member) => Schema.Struct({ op: member.fields.op })))
  )
)
