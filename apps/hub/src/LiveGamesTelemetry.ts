import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { GameEvent } from "@sportal/domain/GameEvent"
import type { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { FoldReport } from "@sportal/domain/LiveGames"
import {
  Cause,
  type Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Metric,
  Option,
  PubSub,
  Ref,
  Schema
} from "effect"

/** A report's logs, metrics, and published events, as a live fold tells them. */
export function reported(
  report: FoldReport,
  seq: Option.Option<number>,
  events: PubSub.PubSub<Data.TaggedEnum.Value<FoldReport, "Happened">>
): Effect.Effect<void> {
  return FoldReport.$match(report, {
    Took: ({ snapshot, from, outcome, had }) =>
      Effect.logDebug(
        `LiveGames: ${snapshot.matchup()}: ${outcome} ${from} ${snapshot.gameTime()}${Option.match(had, {
          onNone: () => "",
          onSome: (had) => ` (had ${had.gameTime()})`
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
        Effect.andThen(before.watchability.lull === after.watchability.lull ? Effect.void : logLull(after)),
        Effect.annotateLogs(annotationsOf(after.snapshot))
      ),
    Stopped: ({ liveGame, at }) =>
      logLifecycle("stopped", liveGame, at).pipe(
        Effect.andThen(gaugeState(liveGame, 0)),
        Effect.annotateLogs(annotationsOf(liveGame.snapshot))
      ),
    Happened: (happened) =>
      logEvent(happened.event, happened.snapshot).pipe(
        Effect.andThen(
          happened.event._tag === "Played"
            ? Metric.update(Metric.withAttributes(plays, { league: happened.snapshot.league }), 1)
            : Effect.void
        ),
        Effect.andThen(PubSub.publish(events, happened)),
        Effect.annotateLogs(annotationsOf(happened.snapshot))
      ),
    Dropped: ({ game, reason }) =>
      Effect.logDebug(`LiveGames: plays for game ${game} dropped: ${reason}`).pipe(
        Effect.andThen(Metric.update(Metric.withAttributes(deliveriesDropped, { reason }), 1))
      ),
    Raised: ({ snapshot, cause, by }) =>
      logDefect(`LiveGames: ${by} raised a defect; keeping the last good live game`, cause, snapshot, seq)
  })
}

/** A report as a replay tells it: only plays are counted for the summary, and a defect is still logged. */
export function quiet(
  report: FoldReport,
  seq: Option.Option<number>,
  plays: Ref.Ref<number>
): Effect.Effect<void> {
  return FoldReport.$match(report, {
    Took: () => Effect.void,
    Started: () => Effect.void,
    Changed: () => Effect.void,
    Stopped: () => Effect.void,
    Happened: ({ event }) =>
      event._tag === "Played" ? Ref.update(plays, (count) => count + 1) : Effect.void,
    Dropped: () => Effect.void,
    Raised: ({ snapshot, cause, by }) =>
      logDefect(
        `LiveGames: ${by} raised a defect in replay; keeping the last good live game`,
        cause,
        snapshot,
        seq
      )
  })
}

/** A held game's state and watchability gauges. */
export function gaugeHeld(liveGame: LiveGame): Effect.Effect<void> {
  return gaugeState(liveGame, stateValues[liveGame.state._tag]).pipe(
    Effect.andThen(gaugeWatchability(liveGame))
  )
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

/** A defect in the fold's timer, logged and counted. */
export function timerDefect(defect: unknown): Effect.Effect<void> {
  return Effect.logError("LiveGames: the timer raised a defect", Cause.die(defect)).pipe(
    Effect.andThen(Metric.update(gameDefects, 1))
  )
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
    `LiveGames: ${liveGame.snapshot.matchup()}: ${what}, ${liveGame.state._tag} at ${liveGame.snapshot.gameTime()}`
  )
}

function gaugeState(liveGame: LiveGame, value: number): Effect.Effect<void> {
  return Metric.update(Metric.withAttributes(gameState, annotationsOf(liveGame.snapshot)), value)
}

function gaugeWatchability(liveGame: LiveGame): Effect.Effect<void> {
  const attributes = annotationsOf(liveGame.snapshot)
  return Metric.update(
    Metric.withAttributes(watchabilityScore, attributes),
    liveGame.watchability.score
  ).pipe(
    Effect.andThen(
      Metric.update(Metric.withAttributes(lulls, attributes), liveGame.watchability.lull ? 1 : 0)
    )
  )
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
    `LiveGames: ${after.snapshot.matchup()}: ${from} → ${to} at ${after.snapshot.gameTime()}${since}`
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

/** A lull beginning or ending, at Info, with its reasons. */
function logLull(liveGame: LiveGame): Effect.Effect<void> {
  const { lull, score, reasons } = liveGame.watchability
  return Effect.logInfo(
    `LiveGames: ${liveGame.snapshot.matchup()}: a lull ${lull ? "began" : "ended"}, watchability ${score}${
      reasons.length === 0 ? "" : ` (${reasons.join(", ")})`
    }`
  )
}

/** Info, with the event's fields as annotations, so the dashboard can mark it on the game's timeline. */
function logEvent(event: GameEvent, snapshot: GameSnapshot): Effect.Effect<void> {
  const { _tag, ...fields } = event
  const team = "team" in event ? ` ${snapshot.abbreviationOf(event.team)}` : ""
  return Effect.logInfo(`LiveGames: ${snapshot.matchup()}: ${_tag}${team} at ${snapshot.gameTime()}`).pipe(
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

// Each state's value on `sportal_game_state`, where 0 is a game the fold has let go. Written as a record so that a new
// state fails to compile here.
const stateValues = { Upcoming: 1, Live: 2, Stale: 3, Over: 4 } satisfies Record<
  LiveGameState["_tag"],
  number
>

// Every state, so a state with no games reads 0.
const everyState = Object.keys(stateValues)

const snapshots = Metric.counter("sportal_snapshots", {
  description:
    "Snapshots the fold took, ignored as behind its live game, or kept (a tied poll that refreshed a pushed snapshot)",
  incremental: true
})

const plays = Metric.counter("sportal_plays", { description: "New plays, by league", incremental: true })

const deliveriesDropped = Metric.counter("sportal_deliveries_dropped", {
  description: "Deliveries the fold could not apply, by reason",
  incremental: true
})

const liveGamesByState = Metric.gauge("sportal_live_games", {
  description: "Live games in the fold, by state"
})

const gameDefects = Metric.counter("sportal_game_defects", {
  description: "Defects in the fold: a step on one game, or the timer",
  incremental: true
})

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's state, by game: 1 Upcoming, 2 Live, 3 Stale, 4 Over, 0 once the fold lets it go"
})

const watchabilityScore = Metric.gauge("sportal_watchability", {
  description: "How worth watching a game is, 0–100, by game"
})

const lulls = Metric.gauge("sportal_lull", {
  description: "Whether a game is in a lull (1) or not (0), by game"
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

/** How long the fold takes to apply one delivery, as its caller waits. */
export const takeDuration = Metric.timer("sportal_take_duration", {
  description: "How long the fold takes to apply one delivery, as its caller waits"
})
