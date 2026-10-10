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
import type { Topic } from "./Topic.ts"

/**
 * Each FastCast game topic's document, its plays by id at `gamePlays`: waiting for its checkpoint, or synced as of a
 * message.
 */
export class FastCastDocuments extends Data.Class<{
  readonly byTopic: HashMap.HashMap<Topic, Document>
}> {
  /** No topic has a document yet. */
  static readonly empty: FastCastDocuments = new FastCastDocuments({ byTopic: HashMap.empty() })

  /**
   * The documents after `frame`, and what it changed: all of a game topic's plays, by id, when they changed, with the
   * ids of the plays touched (every one, on a checkpoint). A topic is synced by its checkpoint frame and moved on by each message after it. A missed
   * message, a patch that will not apply, or a message that does not decode on a synced topic sends only that topic
   * back to waiting for a checkpoint, and the change is a `Reset` of it. A message of an op it does not know is
   * skipped. Fails only when any other frame does not decode, leaving the documents as they were.
   */
  advance(
    frame: Frame
  ): Effect.Effect<
    { readonly documents: FastCastDocuments; readonly change: Option.Option<DocumentChange> },
    Schema.SchemaError
  > {
    return Effect.map(advanced(this.byTopic, frame), ({ documents, change }) => ({
      documents: new FastCastDocuments({ byTopic: documents }),
      change
    }))
  }

  /** These documents, keeping only the topics `kept` says. */
  retained(kept: (topic: Topic) => boolean): FastCastDocuments {
    return new FastCastDocuments({ byTopic: HashMap.filter(this.byTopic, (_, topic) => kept(topic)) })
  }

  /** Whether `topic`'s document is synced: its checkpoint read, and every message since applied. */
  isSynced(topic: Topic): boolean {
    return Option.exists(HashMap.get(this.byTopic, topic), Document.$is("Synced"))
  }
}

/**
 * What a frame changed: a game topic's plays, by id, with the ids it touched (every one, when none), or a topic sent
 * back to waiting for a checkpoint, and why.
 */
export type DocumentChange = Data.TaggedEnum<{
  Game: {
    readonly league: LeagueId
    readonly game: GameId
    readonly plays: Readonly<Record<string, Schema.Json>>
    readonly touched: Option.Option<ReadonlyArray<string>>
  }
  Reset: { readonly topic: Topic; readonly detail: string }
}>
export const DocumentChange = Data.taggedEnum<DocumentChange>()

/** Where one topic's document is: waiting for a checkpoint, or synced as of a message. */
type Document = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Synced: { readonly mid: number; readonly document: Schema.Json }
}>
const Document = Data.taggedEnum<Document>()

type Documents = HashMap.HashMap<Topic, Document>

/** The documents after a frame, and what it changed. */
interface Advanced {
  readonly documents: Documents
  readonly change: Option.Option<DocumentChange>
}

function advanced(documents: Documents, frame: Frame): Effect.Effect<Advanced, Schema.SchemaError> {
  return Frame.$is("Checkpoint")(frame) ? Effect.succeed(synced(documents, frame)) : moveOn(documents, frame)
}

/** The documents after a frame that changed nothing. */
function unchanged(documents: Documents): Advanced {
  return { documents, change: Option.none() }
}

function synced(documents: Documents, frame: Data.TaggedEnum.Value<Frame, "Checkpoint">): Advanced {
  return {
    documents: HashMap.set(
      documents,
      frame.topic,
      Document.Synced({ mid: frame.mid, document: frame.document })
    ),
    change: Option.some(changeOf(frame.topic, frame.document, Option.none()))
  }
}

const moveOn = Effect.fnUntraced(function* (
  documents: Documents,
  frame: Data.TaggedEnum.Value<Frame, "Pushed">
): Effect.fn.Return<Advanced, Schema.SchemaError> {
  if (Option.isNone(frame.envelope)) return unchanged(documents)
  const decoded = yield* decodeMessage(frame.envelope.value).pipe(Effect.result)
  if (Result.isFailure(decoded)) return yield* undecoded(documents, frame, decoded.failure)

  const message = decoded.success
  if (Option.isNone(frame.topic) || !movesOn(message)) return unchanged(documents)

  return yield* moved(documents, frame.topic.value, message)
})

/** Where a game topic's plays are in its document. */
const gamePlays = "/entities/plays"

/** What a game topic's document says: its whole list of plays, with the ones `touched` names. */
function changeOf(
  topic: Topic,
  document: Schema.Json,
  touched: Option.Option<ReadonlyArray<string>>
): DocumentChange {
  return DocumentChange.Game({
    league: topic.league,
    game: topic.game,
    plays: objectAt(document, tokens(gamePlays)),
    touched
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

  const patches = message.op === "I" ? [] : relevant(message.pl)
  const applied = yield* Effect.reduce(
    patches,
    () => document,
    (patchedSoFar, patch) => patched(patchedSoFar, patch)
  ).pipe(Effect.result)
  if (Result.isFailure(applied)) return reset(documents, topic, applied.failure)

  const next = applied.success
  const synced = HashMap.set(documents, topic, Document.Synced({ mid: message.mid, document: next }))
  const touched = playsTouched(patches)
  return {
    documents: synced,
    change: patches.length === 0 ? Option.none() : Option.some(changeOf(topic, next, touched))
  }
})

/** Only the patches inside the plays: the rest of ESPN's game package is not kept. */
function relevant(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): ReadonlyArray<typeof FastCastMessage.Patch.Type> {
  const inPlays = (pointer: string) => pointer === gamePlays || pointer.startsWith(`${gamePlays}/`)
  return patches.filter((patch) => inPlays(patch.path) && (!("from" in patch) || inPlays(patch.from)))
}

/** The play ids `patches` touch, at their path or their `from`; none when one patches the plays whole. */
function playsTouched(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): Option.Option<ReadonlyArray<string>> {
  const pointers = patches.flatMap((patch) => ("from" in patch ? [patch.path, patch.from] : [patch.path]))
  if (pointers.includes(gamePlays)) return Option.none()

  return Option.some(Arr.dedupe(pointers.flatMap((pointer) => Option.toArray(Arr.get(tokens(pointer), 2)))))
}

/** The documents with `topic` sent back to waiting for its checkpoint, and the reset that changed, for `detail`. */
function reset(documents: Documents, topic: Topic, detail: string): Advanced {
  return {
    documents: HashMap.set(documents, topic, Document.AwaitingCheckpoint()),
    change: Option.some(DocumentChange.Reset({ topic, detail }))
  }
}

/**
 * The document with `patch` applied. `JsonPatch` has no `copy` or `move`: a copy is an add of the value read at `from`,
 * a move a remove of `from` then that add.
 */
function patched(
  document: Schema.Json,
  patch: typeof FastCastMessage.Patch.Type
): Effect.Effect<Schema.Json, string> {
  if ("from" in patch) {
    return Option.match(valueAt(document, tokens(patch.from)), {
      onNone: () => Effect.fail(`${described(patch)}: nothing at ${patch.from}`),
      onSome: (value) =>
        applied(
          document,
          [
            ...(patch.op === "move" ? [{ op: "remove" as const, path: patch.from }] : []),
            { op: "add", path: patch.path, value }
          ],
          patch
        )
    })
  }
  if (patch.op === "remove") return applied(document, [{ op: "remove", path: patch.path }], patch)

  return applied(document, [{ op: patch.op, path: patch.path, value: patch.value }], patch)
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
  return `${patch.op} at ${patch.path}`
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
  frame: Data.TaggedEnum.Value<Frame, "Pushed">,
  error: Schema.SchemaError
): Effect.Effect<Advanced, Schema.SchemaError> {
  return Option.match(Option.flatMap(frame.envelope, decodeKnownOp), {
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

const decodeMessage = Schema.decodeUnknownEffect(FastCastMessage.Message)

const decodeKnownOp = Schema.decodeUnknownOption(
  Schema.Union(FastCastMessage.Message.members.map((member) => Schema.Struct({ op: member.fields.op })))
)
