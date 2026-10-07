import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import type { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { SlateObservation, type Taken } from "@sportal/domain/Slate"
import { Cause, DateTime, Duration, Effect, Exit, Match, Metric, Option, Schema } from "effect"
import { observed } from "./DecodeTelemetry.ts"
import type { Decoded } from "./provider/Provider.ts"
import type { Following } from "./Slate.ts"

/**
 * What one take or tick of the slate did, told as its following stands. During the replay, only a defect is logged:
 * every decode observation and slate observation was told when its frame first arrived. Otherwise each decode
 * observation of the frame taken is told, then each slate observation and each game event is logged and counted. `frame` is the frame taken; a tick has
 * none.
 */
export function told(following: Following, frame: Option.Option<Decoded>, taken: Taken): Effect.Effect<void> {
  const { observations, events } = taken
  const seq = Option.map(frame, ({ seq }) => seq)
  const loudly = () =>
    Option.match(frame, {
      onNone: () => Effect.void,
      onSome: (decoded) =>
        Effect.forEach(decoded.observations, (observation) => observed(observation, decoded.seq), {
          discard: true
        })
    }).pipe(
      Effect.andThen(
        Effect.forEach(observations, (observation) => toldLive(observation, seq), { discard: true })
      ),
      Effect.andThen(Effect.forEach(events, (event) => toldEvent(event, observations), { discard: true }))
    )
  return Match.valueTags(following, {
    Replaying: () =>
      Effect.forEach(observations, (observation) => toldInReplay(observation, seq), { discard: true }),
    Live: loudly,
    Halted: loudly
  })
}

/** A held game's state gauge. */
export function gaugeHeld(liveGame: LiveGame): Effect.Effect<void> {
  return gaugeState(liveGame, stateValues[liveGame.state._tag])
}

/** Gauges how many live games are in each state; a state with none reads 0. */
export function countByState(games: ReadonlyMap<GameId, LiveGame>): Effect.Effect<void> {
  const states = [...games.values()].map(({ state }) => state._tag)
  return Effect.forEach(
    everyState,
    (state) =>
      Metric.update(
        Metric.withAttributes(liveGamesByState, { state }),
        states.filter((other) => other === state).length
      ),
    { discard: true }
  )
}

/** A defect in the slate's timer, logged and counted. */
export function timerDefect(defect: unknown): Effect.Effect<void> {
  return Effect.logError("Slate: the timer raised a defect", Cause.die(defect)).pipe(
    Effect.andThen(Metric.update(gameDefects, 1))
  )
}

/** An observation as a replay tells it: only a defect is logged. */
function toldInReplay(observation: SlateObservation, seq: Option.Option<number>): Effect.Effect<void> {
  return SlateObservation.$is("Raised")(observation)
    ? logDefect(
        `Slate: ${observation.by} raised a defect in replay; keeping the last good live game`,
        observation.cause,
        observation.snapshot,
        seq
      )
    : Effect.void
}

/** An observation's logs and metrics, as a live slate tells them. */
function toldLive(observation: SlateObservation, seq: Option.Option<number>): Effect.Effect<void> {
  return SlateObservation.$match(observation, {
    Took: ({ snapshot, from, outcome, had }) =>
      Effect.logDebug(
        `Slate: ${snapshot.matchup()}: ${outcome} ${from} ${snapshot.statusLine()}${Option.match(had, {
          onNone: () => "",
          onSome: (had) => ` (had ${had.statusLine()})`
        })}`
      ).pipe(
        Effect.andThen(
          Metric.update(
            Metric.withAttributes(snapshots, { outcome, source: from, ...annotationsOf(snapshot) }),
            1
          )
        ),
        Effect.annotateLogs(annotationsOf(snapshot))
      ),
    Started: ({ liveGame, at }) =>
      logLifecycle("started", liveGame, at).pipe(
        Effect.andThen(gaugeHeld(liveGame)),
        Effect.annotateLogs(annotationsOf(liveGame.snapshot))
      ),
    Changed: ({ before, after, at }) =>
      gaugeHeld(after).pipe(
        Effect.andThen(logTransition(before, after, at)),
        Effect.annotateLogs(annotationsOf(after.snapshot))
      ),
    Stopped: ({ liveGame, at }) =>
      logLifecycle("stopped", liveGame, at).pipe(
        Effect.andThen(gaugeState(liveGame, 0)),
        Effect.annotateLogs(annotationsOf(liveGame.snapshot))
      ),
    Dropped: ({ game }) =>
      Effect.logDebug(`Slate: plays for game ${game} dropped: no live game holds it`).pipe(
        Effect.andThen(Metric.update(deliveriesDropped, 1))
      ),
    Raised: ({ snapshot, cause, by }) =>
      logDefect(`Slate: ${by} raised a defect; keeping the last good live game`, cause, snapshot, seq)
  })
}

/**
 * A game event's log and metrics, with the snapshot its step left its game with: the last `Started` or `Changed` of
 * that game at the event's instant in the same take, which every step that says events reports. An event with none is
 * a defect, logged at Error.
 */
function toldEvent(event: GameEvent, observations: ReadonlyArray<SlateObservation>): Effect.Effect<void> {
  const stepped = observations.flatMap((observation) =>
    SlateObservation.$is("Started")(observation) || SlateObservation.$is("Changed")(observation)
      ? [{ at: observation.at, snapshot: afterOf(observation).snapshot }]
      : []
  )
  const step = stepped.findLast(
    ({ at, snapshot }) => snapshot.id === event.game && DateTime.Equivalence(at, event.at)
  )
  return Option.match(Option.fromNullishOr(step), {
    onNone: () =>
      Effect.logError(
        `Slate: ${event.what._tag} for game ${event.game} has no started or changed observation in its take`
      ),
    onSome: ({ snapshot }) =>
      logEvent(event.what, snapshot).pipe(
        Effect.andThen(
          event.what._tag === "Played"
            ? Metric.update(Metric.withAttributes(plays, { league: snapshot.league }), 1)
            : Effect.void
        ),
        Effect.annotateLogs(annotationsOf(snapshot))
      )
  })
}

function afterOf(observation: Extract<SlateObservation, { readonly _tag: "Started" | "Changed" }>): LiveGame {
  return observation._tag === "Started" ? observation.liveGame : observation.after
}

/** Game `snapshot`'s log annotations and metric attributes. */
function annotationsOf(snapshot: GameSnapshot) {
  return { game: snapshot.id, league: snapshot.league, matchup: snapshot.matchup() }
}

/** Info for a game that is current, Debug otherwise. */
function logLifecycle(
  what: "started" | "stopped",
  liveGame: LiveGame,
  now: DateTime.Utc
): Effect.Effect<void> {
  return Effect.logWithLevel(liveGame.isCurrent(now) ? "Info" : "Debug")(
    `Slate: ${liveGame.snapshot.matchup()}: ${what}, ${liveGame.state._tag} at ${liveGame.snapshot.statusLine()}`
  )
}

function gaugeState(liveGame: LiveGame, value: number): Effect.Effect<void> {
  return Metric.update(Metric.withAttributes(gameState, annotationsOf(liveGame.snapshot)), value)
}

function logTransition(before: LiveGame, after: LiveGame, now: DateTime.Utc): Effect.Effect<void> {
  const from = before.state._tag
  const to = after.state._tag
  if (from === to) return Effect.void
  const silent = Option.map(before.updatedAt(), (at) => DateTime.distance(at, now))
  const since = Option.match(silent, {
    onNone: () => "",
    onSome: (duration) => `, ${Math.round(Duration.toSeconds(duration))} s since the last update`
  })
  return Effect.logInfo(
    `Slate: ${after.snapshot.matchup()}: ${from} → ${to} at ${after.snapshot.statusLine()}${since}`
  ).pipe(
    Effect.andThen(Metric.update(Metric.withAttributes(transitions, { from, to }), 1)),
    Effect.andThen(
      Option.match(silent, {
        onNone: () => Effect.void,
        onSome: (duration) =>
          from === "Stale"
            ? Metric.update(Metric.withAttributes(staleDuration, annotationsOf(after.snapshot)), duration)
            : Effect.void
      })
    )
  )
}

/** Info, with the event's fields as annotations, so the dashboard can mark it on the game's timeline. */
function logEvent(event: GameEventKind, snapshot: GameSnapshot): Effect.Effect<void> {
  const { _tag, ...fields } = event
  const team = "team" in event ? ` ${snapshot.abbreviationOf(event.team)}` : ""
  return Effect.logInfo(`Slate: ${snapshot.matchup()}: ${_tag}${team} at ${snapshot.statusLine()}`).pipe(
    Effect.andThen(
      Metric.update(Metric.withAttributes(gameEvents, { ...annotationsOf(snapshot), event: _tag }), 1)
    ),
    Effect.annotateLogs({ ...fields, event: _tag })
  )
}

/**
 * Logs a defect at Error with the game's annotations, the frame's `seq`, and `snapshot` encoded, and counts it. A
 * snapshot that cannot be encoded is logged by its id, so the log itself never raises a defect.
 */
function logDefect(
  message: string,
  cause: Cause.Cause<never>,
  snapshot: GameSnapshot,
  seq: Option.Option<number>
): Effect.Effect<void> {
  return Effect.logError(message, cause).pipe(
    Effect.andThen(Metric.update(gameDefects, 1)),
    Effect.annotateLogs({
      ...annotationsOf(snapshot),
      snapshot: Exit.match(Schema.encodeExit(GameSnapshot)(snapshot), {
        onSuccess: (encoded) => encoded,
        onFailure: () => snapshot.id
      })
    }),
    Effect.annotateLogs(Option.match(seq, { onNone: () => ({}), onSome: (seq) => ({ seq }) }))
  )
}

// Each state's value on `sportal_game_state`, where 0 is a game the slate has let go. Written as a record so that a new
// state fails to compile here.
const stateValues = { Upcoming: 1, Live: 2, Stale: 3, Over: 4 } satisfies Record<
  LiveGameState["_tag"],
  number
>

// Every state, so a state with no games reads 0.
const everyState = Object.keys(stateValues)

const snapshots = Metric.counter("sportal_snapshots", {
  description:
    "Snapshots the slate took, ignored as behind its live game, or kept (a tied poll that refreshed a pushed snapshot)",
  incremental: true
})

const plays = Metric.counter("sportal_plays", { description: "New plays, by league", incremental: true })

const deliveriesDropped = Metric.counter("sportal_deliveries_dropped", {
  description: "Plays the slate dropped, since no live game held their game",
  incremental: true
})

const liveGamesByState = Metric.gauge("sportal_live_games", {
  description: "Live games in the slate, by state"
})

const gameDefects = Metric.counter("sportal_game_defects", {
  description: "Defects in the slate: a step on one game, or the timer",
  incremental: true
})

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's state, by game: 1 Upcoming, 2 Live, 3 Stale, 4 Over, 0 once the slate lets it go"
})

const transitions = Metric.counter("sportal_transitions", {
  description: "Changes of a live game's state, by the state before and after",
  incremental: true
})

const staleDuration = Metric.timer("sportal_stale_duration", {
  description: "How long a stale game went without a snapshot, recorded when it is taken again",
  boundaries: [90, 120, 180, 300, 600, 900, 1800, 3600].map((seconds) => seconds * 1000)
})

const gameEvents = Metric.counter("sportal_game_events", {
  description: "Events in a game, by game and event",
  incremental: true
})

export const takeDuration = Metric.timer("sportal_take_duration", {
  description: "How long the slate takes to apply one frame"
})
