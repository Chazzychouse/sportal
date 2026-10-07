import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import type { FeedFrame } from "../Frame.ts"
import { HubConfig } from "../HubConfig.ts"
import type { Decoder } from "../provider/Decoder.ts"
import { type Polling, Provider } from "../provider/Provider.ts"
import type { RecordedScenario } from "./RecordedScenario.ts"
import { RecordedScenarios, ScenarioUnknown, type ScenarioUnreadable } from "./RecordedScenarios.ts"
import type { Scenario } from "./Scenario.ts"
import { scenarios } from "./written/Scenarios.ts"

/**
 * The scenario `SPORTAL_SCENARIO` names as the provider, on whatever clock runs it, from the moment the layer is built.
 * A written scenario is played by `written`, given what a poll of a league answers (the league's games in its slate at
 * that scenario time) and when to poll again (at each written frame's time, and at least every 10 seconds). A recorded
 * scenario polls the recorded poll current at the moment, received now, pushes its recorded live feed frames at their
 * recorded offsets, and is polled again at its next poll's time and at least every 10 seconds. A name that is unset or
 * unknown fails, listing the known ones, written and recorded.
 */
export function layer(
  written: (feed: {
    readonly games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>>
    readonly polling: Polling
  }) => Layer.Layer<Provider>
): Layer.Layer<Provider, ScenarioUnknown | ScenarioUnreadable, HubConfig | RecordedScenarios> {
  return Layer.unwrap(
    Effect.map(
      writtenNamed,
      Option.match({
        onSome: (scenario) => Layer.unwrap(Effect.map(feedOf(scenario), written)),
        onNone: () => recorded
      })
    )
  )
}

/**
 * The decoder that reads the frames of the scenario `SPORTAL_SCENARIO` names: `written` when it names a written
 * scenario, and otherwise `recorded`, the decode of the provider that recorded it. It never loads a recording; a name
 * that is unknown is left for `layer` to fail on.
 */
export function decoder(adapters: {
  readonly written: Layer.Layer<Decoder>
  readonly recorded: Layer.Layer<Decoder>
}): Layer.Layer<Decoder, never, HubConfig> {
  return Layer.unwrap(
    Effect.map(writtenNamed, (named) => (Option.isSome(named) ? adapters.written : adapters.recorded))
  )
}

// The written scenario `SPORTAL_SCENARIO` names, if it names one; `layer` and `decoder` choose by it alike.
const writtenNamed = Effect.gen(function* () {
  const { scenario } = yield* HubConfig
  return Option.flatMap(scenario, (name) => Option.fromUndefinedOr(scenarios.get(name)))
})

// Written `scenario` from now, as the games a poll answers and when to poll again.
function feedOf(scenario: Scenario) {
  return Effect.gen(function* () {
    const start = yield* DateTime.now
    yield* Effect.logInfo(
      `ScenarioProvider: playing ${scenario.name}, ${scenario.frames.length} written frames`
    )
    return {
      games: (league: LeagueId) =>
        DateTime.now.pipe(
          Effect.map((now) =>
            scenario.slateAt(start, DateTime.distance(start, now)).filter((game) => game.league === league)
          ),
          Effect.withSpan("ScenarioProvider.poll", { attributes: { "sportal.league": league } })
        ),
      polling: pollingAt(
        scenario.frames.map(({ at }) => at),
        start
      )
    }
  })
}

// The recorded scenario `SPORTAL_SCENARIO` names as the provider, from the moment the layer is built.
const recorded: Layer.Layer<Provider, ScenarioUnknown | ScenarioUnreadable, HubConfig | RecordedScenarios> =
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const { scenario } = yield* HubConfig
      const recordedScenarios = yield* RecordedScenarios
      const start = yield* DateTime.now
      const name = Option.getOrElse(scenario, () => "")
      const loaded = yield* recordedScenarios
        .load(name)
        .pipe(
          Effect.catchTag("ScenarioUnknown", ({ known }) =>
            Effect.fail(new ScenarioUnknown({ name, known: [...scenarios.keys(), ...known] }))
          )
        )
      yield* Effect.logInfo(`ScenarioProvider: playing ${name}, ${loaded.frames.length} recorded frames`)
      return playedRecorded(loaded, start)
    })
  )

function playedRecorded(scenario: RecordedScenario, start: DateTime.Utc) {
  const origin = scenario.origin()
  const offsetOf = (frame: FeedFrame) => DateTime.distance(origin, frame.receivedAt)
  const playedAt = (frame: FeedFrame) => DateTime.addDuration(start, offsetOf(frame))
  const polls = scenario.frames.filter((frame) => frame.feed === "poll")
  const pushes = scenario.frames.filter((frame) => frame.feed === "fastcast")
  return Provider.of({
    poll: (league) =>
      DateTime.now.pipe(
        Effect.map((now): FeedFrame => {
          const recordedNow = DateTime.addDuration(origin, DateTime.distance(start, now))
          const ofLeague = polls.filter((frame) => frame.channel === league)
          const current = Arr.findLast(ofLeague, (frame) =>
            DateTime.isLessThanOrEqualTo(frame.receivedAt, recordedNow)
          ).pipe(Option.orElse(() => Arr.head(ofLeague)))
          return Option.match(current, {
            onNone: () => ({
              receivedAt: now,
              feed: "poll",
              channel: league,
              kind: "response",
              body: noEvents
            }),
            onSome: (frame) => movedTo(frame, now)
          })
        }),
        Effect.withSpan("ScenarioProvider.poll", { attributes: { "sportal.league": league } })
      ),
    push: () =>
      Stream.fromIterable(pushes).pipe(
        Stream.mapEffect((frame) =>
          DateTime.now.pipe(
            Effect.flatMap((now) =>
              Effect.sleep(Duration.max(DateTime.distance(now, playedAt(frame)), Duration.zero))
            ),
            Effect.as(movedTo(frame, playedAt(frame)))
          )
        ),
        Stream.concat(Stream.never)
      ),
    polling: pollingAt(
      polls.map((frame) => Duration.toMillis(offsetOf(frame))),
      start
    )
  })
}

/** `frame` received at `at` instead, the instant it was sent moved with it. */
function movedTo(frame: FeedFrame, at: DateTime.Utc): FeedFrame {
  const moved = DateTime.distance(frame.receivedAt, at)
  const { sentAt, ...rest } = frame
  return {
    ...rest,
    receivedAt: at,
    ...(sentAt === undefined ? {} : { sentAt: DateTime.addDuration(sentAt, moved) })
  }
}

/** Polled again at the next of `offsets` (milliseconds from `start`) after now, and at least every `longest`. */
function pollingAt(offsets: ReadonlyArray<number>, start: DateTime.Utc): Polling {
  return Schedule.forever.pipe(
    Schedule.modifyDelay(({ now }) => {
      const elapsed = now - DateTime.toEpochMillis(start)
      const next = offsets.find((at) => at > elapsed)
      return Effect.succeed(Duration.millis(Math.min(longest, next === undefined ? longest : next - elapsed)))
    })
  )
}

// The longest a scenario goes without being polled, so a live game never goes stale between its frames.
const longest = 10_000

// A scoreboard with no games, for a league a recorded scenario never polled.
const noEvents = JSON.stringify({ events: [] })
