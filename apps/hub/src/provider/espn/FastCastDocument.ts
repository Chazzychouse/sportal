import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Effect, JsonPatch, JsonPointer, Metric, Option, Record, Schema } from "effect"
import type { Frame } from "../../feed-log/Frame.ts"
import * as FastCastPayload from "./FastCastPayload.ts"

/**
 * The FastCast topics' documents after `frame`, and what it changed: a scoreboard topic's touched events (every event,
 * on a checkpoint), or all of a game topic's plays, by id, when they changed. A topic is synced by its checkpoint
 * frame and moved on by each message after it. A missed message, a patch that will not apply, or a message that does
 * not decode on a synced topic sends only that topic back to waiting for a checkpoint, logged and counted, and the
 * change is `reset`. Fails only when any other frame does not decode, leaving the documents as they were.
 */
export function advance(documents: Documents, frame: Frame): Effect.Effect<Advanced, Schema.SchemaError> {
  const owned = owner(frame.channel)
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
 * The FastCast topic of `league`'s scoreboard, or of one game's package. A college game's topic is assumed to follow
 * its scoreboard's, unverified until a live college day.
 */
export function topic(league: LeagueId, game?: GameId): string {
  const sport = league === "nfl" ? "football-nfl" : "football-college-football"
  return game === undefined ? `event-${sport}` : `gp-${sport}-${game}`
}

/** The league, and for a game topic the game, whose FastCast topic `tc` is. */
export function owner(
  tc: string
): Option.Option<{ readonly league: LeagueId; readonly game: Option.Option<GameId> }> {
  return Arr.findFirst(LeagueId.literals, (league) => {
    const gamePrefix = topic(league, GameId.make(""))
    return tc === topic(league)
      ? Option.some({ league, game: Option.none() })
      : tc.startsWith(gamePrefix) && tc.length > gamePrefix.length
        ? Option.some({ league, game: Option.some(GameId.make(tc.slice(gamePrefix.length))) })
        : Option.none()
  })
}

/**
 * Where one topic's document is: waiting for a checkpoint, or synced as of a message. A scoreboard topic's document
 * is its events by uid; a game topic's is `{ entities: { plays } }`, its plays by id.
 */
type Topic = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Synced: { readonly mid: number; readonly document: Schema.Json }
}>
const Topic = Data.taggedEnum<Topic>()

type Documents = ReadonlyMap<string, Topic>

/** The documents after a frame, and what it changed. */
type Advanced = readonly [
  Documents,
  Option.Option<
    | {
        readonly topic: "scoreboard"
        readonly league: LeagueId
        readonly events: ReadonlyArray<Schema.Json>
      }
    | {
        readonly topic: "game"
        readonly league: LeagueId
        readonly game: GameId
        readonly plays: Readonly<Record<string, Schema.Json>>
      }
    | { readonly topic: "reset" }
  >
]

function checkpoint(
  owner: { readonly game: Option.Option<GameId> },
  frame: Frame
): Effect.Effect<{ readonly mid: number; readonly document: Schema.Json }, Schema.SchemaError> {
  return Option.isNone(owner.game)
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
  Schema.Struct({ sourceId: Schema.Int, body: Schema.fromJsonString(FastCastPayload.ScoreboardCheckpoint) })
)

const decodeGameCheckpoint = Schema.decodeUnknownEffect(
  Schema.Struct({ sourceId: Schema.Int, body: Schema.fromJsonString(FastCastPayload.GameCheckpoint) })
)

/** What a topic's document says: the events `touched` names (all of them when none), or its whole list of plays. */
function changeOf(
  owner: { readonly league: LeagueId; readonly game: Option.Option<GameId> },
  document: Schema.Json,
  touched: Option.Option<ReadonlyArray<string>>
) {
  const { league } = owner
  return Option.match(owner.game, {
    onNone: () => ({
      topic: "scoreboard" as const,
      league,
      events: Option.match(touched, {
        onNone: () => Record.values(objectAt(document, [])),
        onSome: (uids) => uids.flatMap((uid) => Option.toArray(valueAt(document, [uid])))
      })
    }),
    onSome: (game) => ({
      topic: "game" as const,
      league,
      game,
      plays: objectAt(document, ["entities", "plays"])
    })
  })
}

/** The documents after a message on a topic: a missed one, or a patch that will not apply, resets the topic. */
function moved(
  documents: Documents,
  tc: string,
  owner: { readonly league: LeagueId; readonly game: Option.Option<GameId> },
  message: Extract<typeof FastCastPayload.Message.Type, { readonly op: "R" | "P" | "I" }>
): Effect.Effect<Advanced> {
  const current = documents.get(tc) ?? Topic.AwaitingCheckpoint()
  return Topic.$match(current, {
    AwaitingCheckpoint: () => Effect.succeed([documents, Option.none()] as const),
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
          const touched = Option.isNone(owner.game)
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
  owner: { readonly game: Option.Option<GameId> },
  patches: ReadonlyArray<typeof FastCastPayload.Patch.Type>
): ReadonlyArray<typeof FastCastPayload.Patch.Type> {
  const inPlays = (path: { readonly pointer: string }) =>
    path.pointer === playsPointer || path.pointer.startsWith(`${playsPointer}/`)
  return Option.isNone(owner.game)
    ? patches
    : patches.filter((patch) => inPlays(patch.path) && (!("from" in patch) || inPlays(patch.from)))
}

const playsPointer = "/entities/plays"

function reset(
  documents: Documents,
  tc: string,
  league: LeagueId,
  reason: "Gap" | "Unapplicable",
  cause: string
): Effect.Effect<Advanced> {
  return Effect.logWarning(`FastCastDocument: ${cause}; ${tc} waits for its next checkpoint`).pipe(
    Effect.annotateLogs({ league, topic: tc, reason }),
    Effect.andThen(Metric.update(Metric.withAttributes(resets, { league, reason }), 1)),
    Effect.as([
      new Map([...documents, [tc, Topic.AwaitingCheckpoint()]]),
      Option.some({ topic: "reset" } as const)
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
  owner: { readonly game: Option.Option<GameId> },
  patch: typeof FastCastPayload.Patch.Type
): Effect.Effect<Schema.Json, string> {
  const pointer = ({ uid, pointer }: { readonly uid: string; readonly pointer: string }) =>
    Option.isNone(owner.game) ? `/${JsonPointer.escapeToken(uid)}${pointer}` : pointer
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
      Option.isNone(owner.game) &&
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
  patch: typeof FastCastPayload.Patch.Type
): Effect.Effect<Schema.Json, string> {
  // JsonPatch.apply throws on an operation it cannot apply, and Effect has no variant that does not.
  return Effect.try({
    try: () => JsonPatch.apply(operations, document),
    catch: (cause) => `${described(patch)}: ${String(cause)}`
  })
}

function described(patch: typeof FastCastPayload.Patch.Type): string {
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
  owned: Option.Option<{ readonly league: LeagueId }>,
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
      documents.get(frame.channel)?._tag === "Synced"
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

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(FastCastPayload.Message))

const decodeKnownOp = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union(FastCastPayload.Message.members.map((member) => Schema.Struct({ op: member.fields.op })))
  )
)

function received(
  message: typeof FastCastPayload.Message.Type,
  owned: Option.Option<{ readonly league: LeagueId }>
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
