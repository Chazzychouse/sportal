import type { GameId } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Effect, JsonPatch, JsonPointer, Metric, Option, Record, Schema } from "effect"
import type { Frame } from "../../feed-log/Frame.ts"
import * as FastCastMessage from "./FastCastMessage.ts"

/**
 * The FastCast topics' documents after `frame`, and what it changed: a scoreboard topic's touched events (every event,
 * on a checkpoint), or all of a game topic's plays, by id, when they changed. A topic is synced by its checkpoint
 * frame and moved on by each message after it. A missed message, a patch that will not apply, or a message that does
 * not decode on a synced topic sends only that topic back to waiting for a checkpoint, logged and counted, and the
 * change is a `Reset`. A checkpoint that does not decode is `Unreadable`, and the next message on its topic resets it,
 * so it is asked for again, once: until a checkpoint decodes, another that does not waits without asking. Fails only when any other frame does not decode, leaving the documents as they were.
 */
export function advance(documents: Documents, frame: Frame): Effect.Effect<Advanced, Schema.SchemaError> {
  const owned = FastCastMessage.owner(frame.channel)
  if (frame.kind === "checkpoint") {
    return Option.match(owned, {
      onNone: () => Effect.succeed([documents, Option.none()] as const),
      onSome: (owner) =>
        checkpoint(owner, frame).pipe(
          Effect.map(
            ({ mid, document }) =>
              [
                new Map([...documents, [frame.channel, Topic.Synced({ mid, document })]]),
                Option.some(changeOf(owner, document, Option.none()))
              ] as const
          ),
          Effect.catch((cause) =>
            Effect.succeed([
              new Map([...documents, [frame.channel, unreadable(documents.get(frame.channel))]]),
              Option.some(Change.Unreadable({ cause }))
            ] as const)
          )
        )
    })
  }
  if (frame.kind !== "message") return Effect.succeed([documents, Option.none()])
  return decodeMessage(frame.body).pipe(
    Effect.tap((message) => received(message, owned)),
    Effect.flatMap((message) =>
      Option.isSome(owned) && (message.op === "R" || message.op === "P" || message.op === "I")
        ? moved(documents, frame.channel, owned.value, message)
        : Effect.succeed([documents, Option.none()] as const)
    ),
    Effect.catch((error) => undecoded(documents, frame, owned, error))
  )
}

/** No topic has a document yet. */
export const empty: Documents = new Map()

/**
 * Where one topic's document is: waiting for a checkpoint, synced as of a message, lost to a checkpoint that did not
 * decode (its next message asks for another), or waiting for one that decodes after asking for another once. A
 * scoreboard topic's document is its events by uid; a game topic's is `{ entities: { plays } }`, its plays by id.
 */
type Topic = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Synced: { readonly mid: number; readonly document: Schema.Json }
  Unreadable: object
  AskedAgain: object
}>
const Topic = Data.taggedEnum<Topic>()

type Documents = ReadonlyMap<string, Topic>

/** The documents after a frame, and what it changed. */
type Advanced = readonly [Documents, Option.Option<Change>]

/**
 * What a frame changed: a scoreboard topic's touched events, a game topic's whole list of plays, by id, a topic sent
 * back to waiting for a checkpoint, or a topic whose checkpoint did not decode, and why.
 */
type Change = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId; readonly events: ReadonlyArray<Schema.Json> }
  Game: {
    readonly league: LeagueId
    readonly game: GameId
    readonly plays: Readonly<Record<string, Schema.Json>>
  }
  Reset: object
  Unreadable: { readonly cause: Schema.SchemaError }
}>
const Change = Data.taggedEnum<Change>()

function checkpoint(
  owner: FastCastMessage.Owner,
  frame: Frame
): Effect.Effect<{ readonly mid: number; readonly document: Schema.Json }, Schema.SchemaError> {
  return owner._tag === "Scoreboard"
    ? decodeScoreboardCheckpoint(frame).pipe(
        Effect.map(({ sourceId, body }) => ({
          mid: sourceId,
          document: Object.fromEntries(
            body.sports.flatMap((sport) =>
              sport.leagues.flatMap((league) => league.events.map((event) => [event.uid, event] as const))
            )
          )
        }))
      )
    : decodeGameCheckpoint(frame).pipe(
        Effect.map(({ sourceId, body }) => ({
          mid: sourceId,
          document: { entities: body.entities?.plays === undefined ? {} : { plays: body.entities.plays } }
        }))
      )
}

const decodeScoreboardCheckpoint = Schema.decodeUnknownEffect(
  Schema.Struct({ sourceId: Schema.Int, body: Schema.fromJsonString(FastCastMessage.ScoreboardCheckpoint) })
)

const decodeGameCheckpoint = Schema.decodeUnknownEffect(
  Schema.Struct({ sourceId: Schema.Int, body: Schema.fromJsonString(FastCastMessage.GameCheckpoint) })
)

/** A topic whose checkpoint did not decode: one that has already asked for another after that keeps waiting. */
function unreadable(topic: Topic | undefined): Topic {
  return topic?._tag === "AskedAgain" ? Topic.AskedAgain() : Topic.Unreadable()
}

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
    Game: ({ league, game }) =>
      Change.Game({ league, game, plays: objectAt(document, ["entities", "plays"]) })
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
    AwaitingCheckpoint: () => Effect.succeed([documents, Option.none()] as const),
    AskedAgain: () => Effect.succeed([documents, Option.none()] as const),
    Unreadable: () =>
      reset(
        documents,
        tc,
        owner.league,
        "Unreadable",
        `message ${message.mid} came after a checkpoint that did not decode`
      ),
    Synced: ({ mid, document }) => {
      if (mid + 1 !== message.mid) {
        return reset(documents, tc, owner.league, "Gap", `message ${message.mid} came after ${mid}`)
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
          return [
            synced,
            patches.length === 0 ? Option.none() : Option.some(changeOf(owner, next, touched))
          ] as const
        }),
        Effect.catch((cause) => reset(documents, tc, owner.league, "Unapplicable", cause))
      )
    }
  })
}

/** On a game topic, only the patches inside `/entities/plays`: the rest of ESPN's game package is not kept. */
function relevant(
  owner: FastCastMessage.Owner,
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): ReadonlyArray<typeof FastCastMessage.Patch.Type> {
  const inPlays = (path: { readonly pointer: string }) =>
    path.pointer === playsPointer || path.pointer.startsWith(`${playsPointer}/`)
  return owner._tag === "Scoreboard"
    ? patches
    : patches.filter((patch) => inPlays(patch.path) && (!("from" in patch) || inPlays(patch.from)))
}

const playsPointer = "/entities/plays"

function reset(
  documents: Documents,
  tc: string,
  league: LeagueId,
  reason: "Gap" | "Unapplicable" | "Unreadable",
  cause: string
): Effect.Effect<Advanced> {
  return Effect.logWarning(`FastCastDocument: ${cause}; ${tc} waits for its next checkpoint`).pipe(
    Effect.annotateLogs({ league, topic: tc, reason }),
    Effect.andThen(Metric.update(Metric.withAttributes(resets, { league, reason }), 1)),
    Effect.as([
      new Map([
        ...documents,
        [tc, documents.get(tc)?._tag === "Unreadable" ? Topic.AskedAgain() : Topic.AwaitingCheckpoint()]
      ]),
      Option.some(Change.Reset())
    ] as const)
  )
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
      Effect.logDebug("FastCastDocument: skipped a message of an unknown op", frame.body).pipe(
        Effect.as([documents, Option.none()] as const)
      ),
    onSome: ({ op }) =>
      Option.isSome(owned) &&
      (op === "R" || op === "P" || op === "I") &&
      (documents.get(frame.channel)?._tag === "Synced" || documents.get(frame.channel)?._tag === "Unreadable")
        ? reset(
            documents,
            frame.channel,
            owned.value.league,
            "Unapplicable",
            `message ${frame.sourceId} does not decode: ${error.message}`
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
): Effect.Effect<void> {
  const mid = "mid" in message ? message.mid : undefined
  const league = Option.map(owned, (owner) => owner.league)
  return Effect.logDebug(`FastCastDocument: ${message.op}${mid === undefined ? "" : ` ${mid}`}`).pipe(
    Effect.annotateLogs(
      Record.getSomes({
        league,
        topic: "tc" in message ? Option.some(message.tc) : Option.none(),
        op: Option.some<string | number>(message.op),
        mid: Option.fromUndefinedOr(mid)
      })
    ),
    Effect.andThen(
      Metric.update(
        Metric.withAttributes(messages, Record.getSomes({ league, op: Option.some(message.op) })),
        1
      )
    )
  )
}

const messages = Metric.counter("sportal_live_feed_messages", {
  description: "FastCast messages received, by league and op",
  incremental: true
})

const resets = Metric.counter("sportal_live_feed_document_resets", {
  description:
    "Times a FastCast topic's document missed a message or could not apply one, by league and reason",
  incremental: true
})
