import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import { FeedFrame } from "../../Frame.ts"
import { HubConfig } from "../../HubConfig.ts"
import {
  type Scenario,
  Scenarios,
  type ScenarioUnknown,
  type ScenarioUnreadable
} from "../../scenario/Scenarios.ts"
import { type Polling, Provider } from "../Provider.ts"

/**
 * The scenario `SPORTAL_SCENARIO` names as the provider, on whatever clock runs it, from the moment the layer is built.
 * Its frames play at their offsets from its first: a poll answers the scenario's poll of that league current at the
 * moment, received now, and the scenario is polled again at its next poll's time and at least every 10 seconds; its
 * live feed frames are pushed at their offsets. A name that is unset or unknown fails, listing the scenarios there are.
 */
export const layer: Layer.Layer<Provider, ScenarioUnknown | ScenarioUnreadable, HubConfig | Scenarios> =
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const { scenario } = yield* HubConfig
      const scenarios = yield* Scenarios
      const start = yield* DateTime.now
      const name = Option.getOrElse(scenario, () => "")
      const loaded = yield* scenarios.load(name)
      yield* Effect.logInfo(`ScenarioProvider: playing ${name}, ${loaded.frames.length} frames`)
      return played(loaded, start)
    })
  )

function played(scenario: Scenario, start: DateTime.Utc) {
  const origin = scenario.origin()
  const offsetOf = (frame: FeedFrame) => DateTime.distance(origin, frame.receivedAt)
  const playedAt = (frame: FeedFrame) => DateTime.addDuration(start, offsetOf(frame))
  const polls = scenario.frames.filter((frame) => frame.feed === "poll")
  const pushes = scenario.frames.filter((frame) => frame.feed === push)
  return Provider.of({
    poll: Effect.fn("ScenarioProvider.poll")(function* (league: LeagueId) {
      yield* Effect.annotateCurrentSpan("sportal.league", league)
      const now = yield* DateTime.now

      const recordedNow = DateTime.addDuration(origin, DateTime.distance(start, now))
      const ofLeague = polls.filter((frame) => frame.channel === league)
      const current = Arr.findLast(ofLeague, (frame) =>
        DateTime.isLessThanOrEqualTo(frame.receivedAt, recordedNow)
      ).pipe(Option.orElse(() => Arr.head(ofLeague)))
      return Option.match(current, {
        onNone: () =>
          new FeedFrame({ receivedAt: now, feed: "poll", channel: league, kind: "response", body: noEvents }),
        onSome: (frame) => movedTo(frame, now)
      })
    }),
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
    ),
    // Its push never fails.
    reconnect: Schedule.spaced("1 second")
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

/**
 * ESPN's spelling, which every scenario is recorded in and played through: `push`, the feed of a push, and `noEvents`,
 * an empty scoreboard, answered for a league a scenario never polled.
 */
const push = "fastcast"
const noEvents = JSON.stringify({ events: [] })
