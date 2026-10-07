import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { GameEvent } from "@sportal/domain/GameEvent"
import type { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { FoldReport } from "@sportal/domain/LiveGames"
import { Cause, DateTime, Duration, Effect, Exit, Match, Metric, Option, Schema } from "effect"
import { noticed } from "./DecodeTelemetry.ts"
import type { Following } from "./LiveGames.ts"
import type { Decoded } from "./provider/Provider.ts"

/**
 * What one take or tick of the live games did, told as their following stands. During the replay, only a defect is
 * logged: every report and notice was told when its frame first arrived. Live, each report is logged and counted, and
 * each notice of the frame taken is told. Stopped, nothing is told. `frame` is the frame taken; a tick has none.
 */
export function told(
  following: Following,
  frame: Option.Option<Decoded>,
  reports: ReadonlyArray<FoldReport>
): Effect.Effect<void> {
  const seq = Option.map(frame, ({ seq }) => seq)
  return Match.valueTags(following, {
    Replaying: () => Effect.forEach(reports, (report) => toldInReplay(report, seq), { discard: true }),
    Live: () =>
      Effect.forEach(reports, (report) => toldLive(report, seq), { discard: true }).pipe(
        Effect.andThen(
          Option.match(frame, {
            onNone: () => Effect.void,
            onSome: ({ notices, seq }) =>
              Effect.forEach(notices, (notice) => noticed(notice, seq), { discard: true })
          })
        )
      ),
    Stopped: () => Effect.void
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

/** A defect in the fold's timer, logged and counted. */
export function timerDefect(defect: unknown): Effect.Effect<void> {
  return Effect.logError("LiveGames: the timer raised a defect", Cause.die(defect)).pipe(
    Effect.andThen(Metric.update(gameDefects, 1))
  )
}

/** A report as a replay tells it: only a defect is logged. */
function toldInReplay(report: FoldReport, seq: Option.Option<number>): Effect.Effect<void> {
  return FoldReport.$is("Raised")(report)
    ? logDefect(
        `LiveGames: ${report.by} raised a defect in replay; keeping the last good live game`,
        report.cause,
        report.snapshot,
        seq
      )
    : Effect.void
}

/** A report's logs and metrics, as a live fold tells them. */
function toldLive(report: FoldReport, seq: Option.Option<number>): Effect.Effect<void> {
  return FoldReport.$match(report, {
    Took: ({ snapshot, from, outcome, had }) =>
      Effect.logDebug(
        `LiveGames: ${snapshot.matchup()}: ${outcome} ${from} ${snapshot.statusLine()}${Option.match(had, {
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
    Happened: (happened) =>
      logEvent(happened.event, happened.snapshot).pipe(
        Effect.andThen(
          happened.event._tag === "Played"
            ? Metric.update(Metric.withAttributes(plays, { league: happened.snapshot.league }), 1)
            : Effect.void
        ),
        Effect.annotateLogs(annotationsOf(happened.snapshot))
      ),
    Dropped: ({ game }) =>
      Effect.logDebug(`LiveGames: plays for game ${game} dropped: no live game holds it`).pipe(
        Effect.andThen(Metric.update(deliveriesDropped, 1))
      ),
    Raised: ({ snapshot, cause, by }) =>
      logDefect(`LiveGames: ${by} raised a defect; keeping the last good live game`, cause, snapshot, seq)
  })
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
    `LiveGames: ${liveGame.snapshot.matchup()}: ${what}, ${liveGame.state._tag} at ${liveGame.snapshot.statusLine()}`
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
    `LiveGames: ${after.snapshot.matchup()}: ${from} → ${to} at ${after.snapshot.statusLine()}${since}`
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
function logEvent(event: GameEvent, snapshot: GameSnapshot): Effect.Effect<void> {
  const { _tag, ...fields } = event
  const team = "team" in event ? ` ${snapshot.abbreviationOf(event.team)}` : ""
  return Effect.logInfo(`LiveGames: ${snapshot.matchup()}: ${_tag}${team} at ${snapshot.statusLine()}`).pipe(
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
  description: "Plays the fold dropped, since no live game held their game",
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
  description: "How long the fold takes to apply one frame"
})
