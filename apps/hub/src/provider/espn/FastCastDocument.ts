import type { GameId } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Effect, JsonPatch, JsonPointer, Option, Record, Schema } from "effect"
import type { Frame } from "../../Frame.ts"
import { Notice } from "../Provider.ts"
import * as FastCastMessage from "./FastCastMessage.ts"

/**
 * The FastCast topics' documents after `frame`, and what it changed: a scoreboard topic's touched events (every event,
 * on a checkpoint), or all of a game topic's plays, by id, when they changed. A topic is synced by its checkpoint
 * frame and moved on by each message after it. A missed message, a patch that will not apply, or a message that does
 * not decode on a synced topic sends only that topic back to waiting for a checkpoint, and the change is a `Reset`. A
 * checkpoint that does not decode leaves its topic waiting, noticed as a frame that did not decode, and asks for
 * nothing: the live feed already followed it again. Each message received and each reset is noticed. Fails only when
 * any other frame does not decode, leaving the documents as they were.
 */
export function advance(documents: Documents, frame: Frame): Effect.Effect<Advanced, Schema.SchemaError> {
  const owned = FastCastMessage.owner(frame.channel)
  if (frame.kind === "checkpoint") {
    return Option.match(owned, {
      onNone: () => Effect.succeed(unchanged(documents)),
      onSome: (owner) =>
        checkpoint(owner, frame).pipe(
          Effect.map(({ mid, document }) => ({
            documents: new Map([...documents, [frame.channel, Topic.Synced({ mid, document })]]),
            change: Option.some(changeOf(owner, document, Option.none())),
            noticed: []
          })),
          Effect.catch((cause) =>
            Effect.succeed({
              documents: new Map([...documents, [frame.channel, Topic.AwaitingCheckpoint()]]),
              change: Option.none(),
              noticed: [
                Notice.FrameUndecoded({ feed: frame.feed, channel: frame.channel, kind: frame.kind, cause })
              ]
            })
          )
        )
    })
  }
  if (frame.kind !== "message") return Effect.succeed(unchanged(documents))
  return decodeMessage(frame.body).pipe(
    Effect.flatMap((message) =>
      (Option.isSome(owned) && (message.op === "R" || message.op === "P" || message.op === "I")
        ? moved(documents, frame.channel, owned.value, message)
        : Effect.succeed(unchanged(documents))
      ).pipe(
        Effect.map((advanced) => ({ ...advanced, noticed: [received(message, owned), ...advanced.noticed] }))
      )
    ),
    Effect.catch((error) => undecoded(documents, frame, owned, error))
  )
}

/** No topic has a document yet. */
export const empty: Documents = new Map()

/**
 * Where one topic's document is: waiting for a checkpoint, or synced as of a message. A scoreboard topic's document is
 * its events by uid; a game topic's is its plays by id, at `gamePlays`.
 */
type Topic = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Synced: { readonly mid: number; readonly document: Schema.Json }
}>
const Topic = Data.taggedEnum<Topic>()

type Documents = ReadonlyMap<string, Topic>

/** The documents after a frame, what it changed, and what was noticed. */
type Advanced = {
  readonly documents: Documents
  readonly change: Option.Option<Change>
  readonly noticed: ReadonlyArray<Notice>
}

function unchanged(documents: Documents): Advanced {
  return { documents, change: Option.none(), noticed: [] }
}

/**
 * What a frame changed: a scoreboard topic's touched events, a game topic's whole list of plays, by id, or a topic sent
 * back to waiting for a checkpoint.
 */
type Change = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId; readonly events: ReadonlyArray<Schema.Json> }
  Game: {
    readonly league: LeagueId
    readonly game: GameId
    readonly plays: Readonly<Record<string, Schema.Json>>
  }
  Reset: object
}>
const Change = Data.taggedEnum<Change>()

function checkpoint(
  owner: FastCastMessage.Owner,
  frame: Frame
): Effect.Effect<{ readonly mid: number; readonly document: Schema.Json }, Schema.SchemaError> {
  return Effect.all({
    mid: decodeMid(frame.sourceId),
    body: Schema.decodeEffect(FastCastMessage.checkpointOf(owner))(frame.body)
  }).pipe(
    Effect.map(({ mid, body }) => ({
      mid,
      document:
        "sports" in body
          ? Object.fromEntries(
              body.sports.flatMap((sport) =>
                sport.leagues.flatMap((league) => league.events.map((event) => [event.uid, event] as const))
              )
            )
          : JsonPatch.apply([{ op: "add", path: gamePlays.pointer, value: body.entities?.plays ?? {} }], {
              entities: {}
            })
    }))
  )
}

const decodeMid = Schema.decodeUnknownEffect(Schema.Int)

/** Where a game topic's plays are in its document. */
const gamePlays = { pointer: "/entities/plays", path: ["entities", "plays"] } as const

/** What a topic's document says: the events `touched` names (all of them when none), or its whole list of plays. */
function changeOf(
  owner: FastCastMessage.Owner,
  document: Schema.Json,
  touched: Option.Option<ReadonlyArray<string>>
): Change {
  return FastCastMessage.Owner.$match(owner, {
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
function moved(
  documents: Documents,
  tc: string,
  owner: FastCastMessage.Owner,
  message: Extract<typeof FastCastMessage.Message.Type, { readonly op: "R" | "P" | "I" }>
): Effect.Effect<Advanced> {
  const current = documents.get(tc) ?? Topic.AwaitingCheckpoint()
  return Topic.$match(current, {
    AwaitingCheckpoint: () => Effect.succeed(unchanged(documents)),
    Synced: ({ mid, document }) => {
      if (mid + 1 !== message.mid) {
        return reset(
          documents,
          tc,
          owner.league,
          "Gap",
          `message ${message.mid} came after ${mid}`,
          Topic.AwaitingCheckpoint()
        )
      }
      const patches = message.op === "I" ? [] : relevant(owner, message.pl)
      return Effect.reduce(
        patches,
        () => document,
        (patchedSoFar, patch) => patched(patchedSoFar, owner, patch)
      ).pipe(
        Effect.map((next) => {
          const synced = new Map([...documents, [tc, Topic.Synced({ mid: message.mid, document: next })]])
          const touched =
            owner._tag === "Scoreboard"
              ? Option.some(Arr.dedupe(patches.map((patch) => patch.path.uid)))
              : Option.none()
          return {
            documents: synced,
            change: patches.length === 0 ? Option.none() : Option.some(changeOf(owner, next, touched)),
            noticed: []
          }
        }),
        Effect.catch((cause) =>
          reset(documents, tc, owner.league, "Unapplicable", cause, Topic.AwaitingCheckpoint())
        )
      )
    }
  })
}

/** On a game topic, only the patches inside its plays: the rest of ESPN's game package is not kept. */
function relevant(
  owner: FastCastMessage.Owner,
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): ReadonlyArray<typeof FastCastMessage.Patch.Type> {
  const inPlays = (path: { readonly pointer: string }) =>
    path.pointer === gamePlays.pointer || path.pointer.startsWith(`${gamePlays.pointer}/`)
  return owner._tag === "Scoreboard"
    ? patches
    : patches.filter((patch) => inPlays(patch.path) && (!("from" in patch) || inPlays(patch.from)))
}

function reset(
  documents: Documents,
  tc: string,
  league: LeagueId,
  reason: "Gap" | "Unapplicable",
  detail: string,
  next: Topic
): Effect.Effect<Advanced> {
  return Effect.succeed({
    documents: new Map([...documents, [tc, next]]),
    change: Option.some(Change.Reset()),
    noticed: [Notice.Reset({ league, topic: tc, reason, detail })]
  })
}

/**
 * The document with `patch` applied. On a scoreboard topic the path's uid is the document's first token, and a path
 * with no pointer adds, replaces, or removes the whole event; removing an event the document lacks changes nothing.
 * `JsonPatch` has no `copy` or `move`: a copy is an add of the value read at `from`, a move a remove of `from` then
 * that add.
 */
function patched(
  document: Schema.Json,
  owner: FastCastMessage.Owner,
  patch: typeof FastCastMessage.Patch.Type
): Effect.Effect<Schema.Json, string> {
  const pointer = ({ uid, pointer }: { readonly uid: string; readonly pointer: string }) =>
    owner._tag === "Scoreboard" ? `/${JsonPointer.escapeToken(uid)}${pointer}` : pointer
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
      owner._tag === "Scoreboard" &&
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
  frame: Frame,
  owned: Option.Option<FastCastMessage.Owner>,
  error: Schema.SchemaError
): Effect.Effect<Advanced, Schema.SchemaError> {
  return Option.match(decodeKnownOp(frame.body), {
    onNone: () =>
      Effect.succeed({ ...unchanged(documents), noticed: [Notice.OpUnknown({ body: frame.body })] }),
    onSome: ({ op }) =>
      Option.isSome(owned) &&
      (op === "R" || op === "P" || op === "I") &&
      documents.get(frame.channel)?._tag === "Synced"
        ? reset(
            documents,
            frame.channel,
            owned.value.league,
            "Unapplicable",
            `message ${frame.sourceId} does not decode: ${error.message}`,
            Topic.AwaitingCheckpoint()
          )
        : Effect.fail(error)
  })
}

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(FastCastMessage.Message))

const decodeKnownOp = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union(FastCastMessage.Message.members.map((member) => Schema.Struct({ op: member.fields.op })))
  )
)

function received(
  message: typeof FastCastMessage.Message.Type,
  owned: Option.Option<FastCastMessage.Owner>
): Notice {
  return Notice.Received({
    league: Option.map(owned, (owner) => owner.league),
    op: message.op,
    topic: "tc" in message ? Option.some(message.tc) : Option.none(),
    mid: Option.fromUndefinedOr("mid" in message ? message.mid : undefined)
  })
}
