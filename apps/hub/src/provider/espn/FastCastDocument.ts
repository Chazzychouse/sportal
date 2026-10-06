import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Data,
  Effect,
  Exit,
  JsonPatch,
  JsonPointer,
  Metric,
  Option,
  Record,
  Schema,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { LiveFeedError } from "../LiveFeed.ts"
import * as FastCastPayload from "./FastCastPayload.ts"

/** The games of each league's scoreboard topic, one batch per message that changes any. */
export function batches(
  leagues: ReadonlyArray<LeagueId>,
  messages: Stream.Stream<typeof FastCastPayload.Message.Type, LiveFeedError>
): Stream.Stream<ReadonlyArray<GameSnapshot>, LiveFeedError, HttpClient.HttpClient> {
  return messages.pipe(
    Stream.mapAccumEffect(
      (): Topics => new Map(leagues.map((league) => [league, Topic.AwaitingCheckpoint()])),
      (topics, message) => {
        if (message.op === "C" || message.op === "B") {
          return received(message, undefined, Exit.succeed([])).pipe(Effect.as([topics, []] as const))
        }
        const league = leagues.find((candidate) => topic(candidate) === message.tc)
        const current = league === undefined ? undefined : topics.get(league)
        if (league === undefined || current === undefined) return Effect.succeed([topics, []] as const)
        return advance(current, message).pipe(
          Effect.flatMap(([next, touched]) =>
            snapshotsOf(league, next, touched).pipe(Effect.map((games) => [next, games] as const))
          ),
          Effect.onExit((exit) =>
            received(
              message,
              league,
              Exit.map(exit, ([, games]) => games)
            )
          ),
          Effect.map(
            ([next, games]) =>
              [new Map([...topics, [league, next]]), games.length === 0 ? [] : [games]] as const
          )
        )
      }
    )
  )
}

/** The scoreboard topic carrying `league`'s games. */
export function topic(league: LeagueId): string {
  return topics[league]
}

const topics: { readonly [League in LeagueId]: string } = {
  nfl: "event-football-nfl",
  fbs: "event-football-college-football"
}

/** Where one topic's document is: waiting for a checkpoint, or synced as of a message, with its events' JSON by uid. */
type Topic = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Synced: { readonly mid: number; readonly games: Games }
}>
const Topic = Data.taggedEnum<Topic>()

type Topics = ReadonlyMap<LeagueId, Topic>
type Games = ReadonlyMap<string, Schema.Json>

/** The topic after `message`, with the uids of the events it touched: on a checkpoint, every event. */
function advance(
  current: Topic,
  message: Exclude<typeof FastCastPayload.Message.Type, { readonly op: "C" | "B" }>
): Effect.Effect<readonly [Topic, ReadonlyArray<string>], LiveFeedError, HttpClient.HttpClient> {
  switch (message.op) {
    case "S":
      return Effect.succeed([current, []])
    case "H":
      return checkpoint(message.pl).pipe(
        Effect.map((games) => [Topic.Synced({ mid: message.mid, games }), [...games.keys()]])
      )
    case "I":
      return following(current, message.mid).pipe(
        Effect.map((games) => [Topic.Synced({ mid: message.mid, games }), []])
      )
    case "R":
    case "P":
      return following(current, message.mid).pipe(
        Effect.flatMap((games) => Effect.reduce(message.pl, () => games, patched)),
        Effect.map((games) => [
          Topic.Synced({ mid: message.mid, games }),
          Arr.dedupe(message.pl.map((patch) => patch.path.uid))
        ])
      )
  }
}

/** The games of a synced topic that message `mid` follows directly; any other message means one was missed. */
function following(current: Topic, mid: number): Effect.Effect<Games, LiveFeedError> {
  return Topic.$match(current, {
    AwaitingCheckpoint: () =>
      Effect.fail(new LiveFeedError({ reason: "Gap", cause: `Message ${mid} came before any checkpoint` })),
    Synced: (synced) =>
      synced.mid + 1 === mid
        ? Effect.succeed(synced.games)
        : Effect.fail(new LiveFeedError({ reason: "Gap", cause: `Message ${mid} came after ${synced.mid}` }))
  })
}

function checkpoint(url: string): Effect.Effect<Games, LiveFeedError, HttpClient.HttpClient> {
  return HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastPayload.CheckpointDocument)),
    Effect.map(
      (document) =>
        new Map(
          document.sports.flatMap((sport) =>
            sport.leagues.flatMap((league) => league.events.map((event) => [event.uid, event] as const))
          )
        )
    ),
    Effect.mapError((cause) => new LiveFeedError({ reason: "Refused", cause }))
  )
}

/**
 * The games with `patch` applied to its event. A path with no pointer replaces, adds, or removes the whole event.
 * `JsonPatch` has no `copy`: a copy is an add of the value read at `from`.
 */
function patched(
  games: Games,
  patch: typeof FastCastPayload.Patch.Type
): Effect.Effect<Games, LiveFeedError> {
  if (patch.op === "copy") {
    return Option.match(
      Option.flatMap(Option.fromUndefinedOr(games.get(patch.from.uid)), (event) =>
        valueAt(event, patch.from.pointer)
      ),
      {
        onNone: () => Effect.fail(unapplicable(patch, "nothing to copy")),
        onSome: (value) => patched(games, { op: "add", path: patch.path, value })
      }
    )
  }
  const { uid, pointer } = patch.path
  if (pointer === "") {
    return Effect.succeed(
      patch.op === "remove"
        ? new Map([...games].filter(([other]) => other !== uid))
        : new Map([...games, [uid, patch.value]])
    )
  }
  const event = games.get(uid)
  if (event === undefined) return Effect.fail(unapplicable(patch, "no such event"))
  // JsonPatch.apply throws on an operation it cannot apply, and Effect has no variant that does not.
  return Effect.try({
    try: () =>
      JsonPatch.apply(
        [patch.op === "remove" ? { op: "remove", path: pointer } : { ...patch, path: pointer }],
        event
      ),
    catch: (cause) => unapplicable(patch, cause)
  }).pipe(Effect.map((next) => new Map([...games, [uid, next]])))
}

function unapplicable(patch: typeof FastCastPayload.Patch.Type, cause: unknown): LiveFeedError {
  return new LiveFeedError({
    reason: "Unapplicable",
    cause: `${patch.op} at ${patch.path.uid}${patch.path.pointer}: ${String(cause)}`
  })
}

function valueAt(json: Schema.Json, pointer: string): Option.Option<Schema.Json> {
  return pointer
    .split("/")
    .slice(1)
    .map(JsonPointer.unescapeToken)
    .reduce(
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

function snapshotsOf(
  league: LeagueId,
  current: Topic,
  touched: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<GameSnapshot>> {
  const games = Topic.$match(current, {
    AwaitingCheckpoint: (): Games => new Map(),
    Synced: (synced) => synced.games
  })
  return Effect.forEach(
    touched.flatMap((uid) =>
      Option.toArray(Option.map(Option.fromUndefinedOr(games.get(uid)), (event) => [uid, event] as const))
    ),
    ([uid, event]) =>
      decodeEvent[league](event).pipe(
        Effect.asSome,
        Effect.catch((issue) =>
          Effect.logWarning("FastCastDocument: skipped an event that failed to decode", issue).pipe(
            Effect.annotateLogs({ league, uid }),
            Effect.andThen(Metric.update(Metric.withAttributes(undecoded, { league }), 1)),
            Effect.as(Option.none())
          )
        )
      )
  ).pipe(Effect.map(Arr.getSomes))
}

const decodeEvent = {
  nfl: Schema.decodeUnknownEffect(FastCastPayload.Event("nfl")),
  fbs: Schema.decodeUnknownEffect(FastCastPayload.Event("fbs"))
}

// Called on exit, so the message that fails the feed is logged and counted too.
function received(
  message: typeof FastCastPayload.Message.Type,
  league: LeagueId | undefined,
  delivered: Exit.Exit<ReadonlyArray<GameSnapshot>, LiveFeedError>
): Effect.Effect<void> {
  const mid = "mid" in message ? message.mid : undefined
  const games = Exit.match(delivered, { onFailure: () => 0, onSuccess: (snapshots) => snapshots.length })
  const where = Record.getSomes({ league: Option.fromUndefinedOr(league), op: Option.some(message.op) })
  return Effect.logDebug(
    `FastCastDocument: ${message.op}${mid === undefined ? "" : ` ${mid}`}, ${Exit.isSuccess(delivered) ? `${games} games` : "failed"}`
  ).pipe(
    Effect.annotateLogs(
      Record.getSomes({
        league: Option.fromUndefinedOr(league),
        op: Option.some<string | number>(message.op),
        mid: Option.fromUndefinedOr(mid)
      })
    ),
    Effect.annotateLogs("games", games),
    Effect.andThen(Metric.update(Metric.withAttributes(messages, where), 1)),
    Effect.andThen(
      league === undefined
        ? Effect.void
        : Metric.update(Metric.withAttributes(gamesDelivered, { league }), games)
    )
  )
}

const messages = Metric.counter("sportal_live_feed_messages", {
  description: "FastCast messages received, by league and op",
  incremental: true
})

const gamesDelivered = Metric.counter("sportal_live_feed_games", {
  description: "Game snapshots the live feed delivered, by league",
  incremental: true
})

const undecoded = Metric.counter("sportal_live_feed_undecoded", {
  description: "Events the live feed changed in a way that no longer decodes, by league",
  incremental: true
})
