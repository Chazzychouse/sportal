import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import { type GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import type { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import type { Slate, Taken } from "@sportal/domain/Slate"
import { SlateObservation } from "@sportal/domain/SlateObservation"
import { Cause, DateTime, Duration, Effect, Exit, Metric, Option, Record as Rec, Schema } from "effect"
import { Following } from "./Following.ts"
import { type Decoded, DecodeObservation } from "./provider/Decoder.ts"

/**
 * What one take or tick of the slate did, told as its following stands. During the replay, only a defect is logged:
 * every decode observation, slate observation and event was told when its frame first arrived. Otherwise each decode
 * observation of the frame taken is told, then each slate observation and each game event is logged and counted, and
 * the live games are counted by state when the take changed which games are live. `frame` is the frame taken; a tick
 * has none. `before` is the slate the take started from.
 */
export const told = Effect.fnUntraced(function* (
  following: Following,
  frame: Option.Option<Decoded>,
  before: Slate,
  taken: Taken
) {
  const seq = Option.map(frame, ({ seq }) => seq)
  const loudly = () => toldLive(frame, before, taken)
  yield* Following.$match(following, {
    Replaying: () =>
      Effect.forEach(taken.observations, (observation) => toldInReplay(observation, seq), { discard: true }),
    Live: loudly,
    Halted: loudly
  })
})

/** The boundary out of the replay: every held game's state gauge, and the live games counted by state. */
export const wentLive = Effect.fnUntraced(function* (slate: Slate) {
  yield* Effect.forEach(slate.live.values(), (liveGame) => gaugeState(liveGame), { discard: true })
  yield* gaugeByState(slate.live)
})

/** A defect in the slate's timer, logged and counted. */
export const timerDefect = Effect.fnUntraced(function* (defect: unknown) {
  yield* Effect.logError("LiveSlate: the timer raised a defect", Cause.die(defect))
  yield* Metric.update(gameDefects, 1)
})

/** `take`, its duration recorded as how long the slate took to apply one frame. */
export function timedTake<A, E, R>(take: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.trackDuration(take, frameTakeDuration)
}

/** A take or tick told live: the frame's decode observations, then each slate observation, each event, and the counts. */
const toldLive = Effect.fnUntraced(function* (frame: Option.Option<Decoded>, before: Slate, taken: Taken) {
  const { next, observations, events } = taken
  const seq = Option.map(frame, ({ seq }) => seq)

  if (Option.isSome(frame)) {
    const decoded = frame.value
    yield* Effect.forEach(decoded.observations, (observation) => observed(observation, decoded.seq), {
      discard: true
    })
  }
  yield* Effect.forEach(observations, (observation) => toldObservation(observation, seq), { discard: true })
  yield* Effect.forEach(events, (event) => toldEvent(event, observations), { discard: true })
  if (next.live !== before.live) {
    yield* gaugeByState(next.live)
  }
})

/** An observation as a replay tells it: only a defect is logged. */
const toldInReplay = Effect.fnUntraced(function* (observation: SlateObservation, seq: Option.Option<number>) {
  if (!SlateObservation.$is("Raised")(observation)) return
  yield* logDefect(
    `LiveSlate: ${observation.by} raised a defect in replay; keeping the last good live game`,
    observation.cause,
    observation.snapshot,
    seq
  )
})

/** What decode observed in frame `seq`, as logs and metrics. */
const observed = Effect.fnUntraced(function* (observation: DecodeObservation, seq: number) {
  yield* DecodeObservation.$match(observation, {
    Received: ({ league, op, topic, mid }) =>
      Effect.logDebug(
        `Decode: received ${op}${Option.match(mid, { onNone: () => "", onSome: (n) => ` ${n}` })}`
      ).pipe(
        Effect.annotateLogs(Rec.getSomes({ league, topic, op: Option.some<string | number>(op), mid })),
        Effect.andThen(
          Metric.update(Metric.withAttributes(messages, Rec.getSomes({ league, op: Option.some(op) })), 1)
        )
      ),
    OpUnknown: ({ body }) => Effect.logDebug("Decode: skipped a message of an unknown op", body),
    Pushed: ({ league, games }) => Metric.update(Metric.withAttributes(gamesPushed, { league }), games),
    Unlisted: ({ league }) => Metric.update(Metric.withAttributes(unlisted, { league }), 1),
    Reset: ({ league, topic, reason, detail }) =>
      Effect.logWarning(`Decode: ${detail}; ${topic} waits for its next checkpoint`).pipe(
        Effect.annotateLogs({ league, topic, reason }),
        Effect.andThen(Metric.update(Metric.withAttributes(resets, { league, reason }), 1))
      ),
    FrameUndecoded: ({ source, channel, kind, cause }) =>
      Effect.logError("Decode: skipped a frame that does not decode", cause).pipe(
        Effect.annotateLogs({ source, channel, kind }),
        Effect.andThen(Metric.update(Metric.withAttributes(framesUndecoded, { source }), 1))
      ),
    EventUndecoded: ({ league, source, cause }) =>
      Effect.logWarning("Decode: skipped an event that does not decode", cause).pipe(
        Effect.annotateLogs({ league, source }),
        Effect.andThen(Metric.update(Metric.withAttributes(eventsUndecoded, { league, source }), 1))
      ),
    PlayUndecoded: ({ league, game, play, cause }) =>
      Effect.logWarning(`Decode: skipped play ${play}, which does not decode`, cause).pipe(
        Effect.annotateLogs({ league, game }),
        Effect.andThen(Metric.update(Metric.withAttributes(playsUndecoded, { league }), 1))
      ),
    PlayTypeUnknown: ({ id, text }) =>
      Effect.logInfo(`Decode: play type ${id} (${text}) is not in the table; read as other`)
  }).pipe(Effect.annotateLogs({ seq }))
})

/** An observation's logs and metrics, as a live slate tells them. */
const toldObservation = Effect.fnUntraced(function* (
  observation: SlateObservation,
  seq: Option.Option<number>
) {
  yield* SlateObservation.$match(observation, {
    Took: ({ snapshot, from, outcome, had }) =>
      // A hold and a fallback are rare, and each says the push fell behind the scoreboard.
      Effect.logWithLevel(outcome === "held" || outcome === "fellBack" ? "Info" : "Debug")(
        `LiveSlate: ${snapshot.matchup()}: ${outcome} ${from} ${snapshot.statusLine()}${Option.match(had, {
          onNone: () => "",
          onSome: (had) => ` (had ${had.statusLine()})`
        })}`
      ).pipe(
        Effect.andThen(
          Metric.update(
            Metric.withAttributes(snapshotsTaken, { outcome, source: from, ...annotationsOf(snapshot) }),
            1
          )
        ),
        Effect.andThen(
          outcome === "fellBack"
            ? Metric.update(Metric.withAttributes(pollFallbacks, { league: snapshot.league }), 1)
            : Effect.void
        ),
        Effect.annotateLogs(annotationsOf(snapshot))
      ),
    Started: ({ after, at }) =>
      logLifecycle("started", after, at).pipe(
        Effect.andThen(gaugeState(after)),
        Effect.annotateLogs(annotationsOf(after.snapshot))
      ),
    Changed: ({ before, after, at }) =>
      gaugeState(after).pipe(
        Effect.andThen(logTransition(before, after, at)),
        Effect.annotateLogs(annotationsOf(after.snapshot))
      ),
    Stopped: ({ after, at }) =>
      logLifecycle("stopped", after, at).pipe(
        Effect.andThen(gaugeState(after, 0)),
        Effect.annotateLogs(annotationsOf(after.snapshot))
      ),
    Dropped: ({ game }) =>
      Effect.logDebug(`LiveSlate: plays for game ${game} dropped: no live game holds it`).pipe(
        Effect.andThen(Metric.update(deliveriesDropped, 1))
      ),
    Raised: ({ snapshot, cause, by }) =>
      logDefect(`LiveSlate: ${by} raised a defect; keeping the last good live game`, cause, snapshot, seq)
  })
})

/**
 * A game event's log and metrics, with the snapshot its step left its game with: the last `Started` or `Changed` of
 * that game at the event's instant in the same take, which every step that says events reports. An event with none is
 * a defect, logged at Error.
 */
const toldEvent = Effect.fnUntraced(function* (
  event: GameEvent,
  observations: ReadonlyArray<SlateObservation>
) {
  const stepped = observations.flatMap((observation) =>
    SlateObservation.$is("Started")(observation) || SlateObservation.$is("Changed")(observation)
      ? [{ at: observation.at, snapshot: observation.after.snapshot }]
      : []
  )
  const step = stepped.findLast(
    ({ at, snapshot }) => snapshot.id === event.game && DateTime.Equivalence(at, event.at)
  )
  if (step === undefined) {
    yield* Effect.logError(
      `LiveSlate: ${event.what._tag} for game ${event.game} has no started or changed observation in its take`
    )
    return
  }

  const { snapshot } = step
  yield* logEvent(event.what, snapshot).pipe(
    Effect.andThen(
      GameEventKind.$is("Played")(event.what)
        ? Metric.update(Metric.withAttributes(playsCounted, { league: snapshot.league }), 1)
        : Effect.void
    ),
    Effect.annotateLogs(annotationsOf(snapshot))
  )
})

/** Game `snapshot`'s log annotations and metric attributes. */
function annotationsOf(snapshot: GameSnapshot) {
  return { game: snapshot.id, league: snapshot.league, matchup: snapshot.matchup() }
}

/** Info for a game that is current, Debug otherwise. */
const logLifecycle = Effect.fnUntraced(function* (
  what: "started" | "stopped",
  liveGame: LiveGame,
  now: DateTime.Utc
) {
  yield* Effect.logWithLevel(liveGame.isCurrent(now) ? "Info" : "Debug")(
    `LiveSlate: ${liveGame.snapshot.matchup()}: ${what}, ${liveGame.state._tag} at ${liveGame.snapshot.statusLine()}`
  )
})

/** A game's state gauge: its state's value while the slate holds it, unless `value` says otherwise. */
const gaugeState = Effect.fnUntraced(function* (
  liveGame: LiveGame,
  value = stateValues[liveGame.state._tag]
) {
  yield* Metric.update(Metric.withAttributes(gameStateGauge, annotationsOf(liveGame.snapshot)), value)
})

/** Gauges how many live games are in each state; a state with none reads 0. */
const gaugeByState = Effect.fnUntraced(function* (games: ReadonlyMap<GameId, LiveGame>) {
  const states = [...games.values()].map(({ state }) => state._tag)
  yield* Effect.forEach(
    everyState,
    (state) =>
      Metric.update(
        Metric.withAttributes(liveGamesByState, { state }),
        states.filter((other) => other === state).length
      ),
    { discard: true }
  )
})

const logTransition = Effect.fnUntraced(function* (before: LiveGame, after: LiveGame, now: DateTime.Utc) {
  const from = before.state._tag
  const to = after.state._tag
  if (from === to) return

  const silent = Option.map(before.updatedAt(), (at) => DateTime.distance(at, now))
  const since = Option.match(silent, {
    onNone: () => "",
    onSome: (duration) => `, ${Math.round(Duration.toSeconds(duration))} s since the last update`
  })
  yield* Effect.logInfo(
    `LiveSlate: ${after.snapshot.matchup()}: ${from} → ${to} at ${after.snapshot.statusLine()}${since}`
  )
  yield* Metric.update(Metric.withAttributes(transitionsCounted, { from, to }), 1)
  if (from === "Stale" && Option.isSome(silent)) {
    yield* Metric.update(Metric.withAttributes(staleDuration, annotationsOf(after.snapshot)), silent.value)
  }
})

/** Info, with the event's fields as annotations, so the dashboard can mark it on the game's timeline. */
const logEvent = Effect.fnUntraced(function* (event: GameEventKind, snapshot: GameSnapshot) {
  const { _tag, ...fields } = event
  const team = "team" in event ? ` ${snapshot.abbreviationOf(event.team)}` : ""
  yield* Effect.logInfo(`LiveSlate: ${snapshot.matchup()}: ${_tag}${team} at ${snapshot.statusLine()}`).pipe(
    Effect.andThen(
      Metric.update(Metric.withAttributes(gameEventsCounted, { ...annotationsOf(snapshot), event: _tag }), 1)
    ),
    Effect.annotateLogs({ ...fields, event: _tag })
  )
})

/**
 * Logs a defect at Error with the game's annotations, the frame's `seq`, and `snapshot` encoded, and counts it. A
 * snapshot that cannot be encoded is logged by its id, so the log itself never raises a defect.
 */
const logDefect = Effect.fnUntraced(function* (
  message: string,
  cause: Cause.Cause<never>,
  snapshot: GameSnapshot,
  seq: Option.Option<number>
) {
  yield* Effect.logError(message, cause).pipe(
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
})

// Each state's value on `sportal_game_state`, where 0 is a game the slate has let go. Written as a record so that a new
// state fails to compile here.
const stateValues = { Upcoming: 1, Live: 2, Stale: 3, Over: 4, Holding: 5 } satisfies Record<
  LiveGameState["_tag"],
  number
>

// Every state, so a state with no games reads 0.
const everyState = Object.keys(stateValues)

const snapshotsTaken = Metric.counter("sportal_snapshots", {
  description:
    "Snapshots the slate took, ignored as behind its live game, or held by a covered game, and held ones that fell back",
  incremental: true
})

const pollFallbacks = Metric.counter("sportal_poll_fallbacks", {
  description: "Held poll snapshots that applied because the push had not caught them up in time, by league",
  incremental: true
})

const playsCounted = Metric.counter("sportal_plays", {
  description: "New plays, by league",
  incremental: true
})

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

const gameStateGauge = Metric.gauge("sportal_game_state", {
  description:
    "A game's state, by game: 1 Upcoming, 2 Live, 3 Stale, 4 Over, 5 Holding, 0 once the slate lets it go"
})

const transitionsCounted = Metric.counter("sportal_transitions", {
  description: "Changes of a live game's state, by the state before and after",
  incremental: true
})

const staleDuration = Metric.timer("sportal_stale_duration", {
  description: "How long a stale game went without a snapshot, recorded when it is taken again",
  boundaries: [90, 120, 180, 300, 600, 900, 1800, 3600].map((seconds) => seconds * 1000)
})

const gameEventsCounted = Metric.counter("sportal_game_events", {
  description: "Events in a game, by game and event",
  incremental: true
})

const frameTakeDuration = Metric.timer("sportal_take_duration", {
  description: "How long the slate takes to apply one frame"
})

const messages = Metric.counter("sportal_live_feed_messages", {
  description: "Live feed messages received, by league and op",
  incremental: true
})

const gamesPushed = Metric.counter("sportal_live_feed_games", {
  description: "Game snapshots the live feed delivered, by league",
  incremental: true
})

const unlisted = Metric.counter("sportal_live_feed_unlisted", {
  description: "Pushed games no poll has listed yet, so not sent",
  incremental: true
})

const resets = Metric.counter("sportal_live_feed_document_resets", {
  description:
    "Times a live feed topic's document missed a message or could not apply one, by league and reason",
  incremental: true
})

const framesUndecoded = Metric.counter("sportal_frames_undecoded", {
  description: "Frames that did not decode and were skipped, by source",
  incremental: true
})

const eventsUndecoded = Metric.counter("sportal_events_undecoded", {
  description: "Events, polled or pushed, that did not decode and were skipped, by league and source",
  incremental: true
})

const playsUndecoded = Metric.counter("sportal_live_feed_undecoded_plays", {
  description: "Plays that did not decode and were left out of their game's list, each once, by league",
  incremental: true
})
