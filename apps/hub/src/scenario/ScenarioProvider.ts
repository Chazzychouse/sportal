import { Delivery } from "@sportal/domain/Delivery"
import { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import type { FeedFrame } from "../Frame.ts"
import { HubConfig } from "../HubConfig.ts"
import { Decoder } from "../provider/Decoder.ts"
import { Decoded, type Polling, Provider, type ProviderError } from "../provider/Provider.ts"
import type { RecordedScenario } from "./RecordedScenario.ts"
import { RecordedScenarios, ScenarioUnknown, type ScenarioUnreadable } from "./RecordedScenarios.ts"
import type { Scenario } from "./Scenario.ts"
import { scenarios } from "./written/Scenarios.ts"

/**
 * The scenario `SPORTAL_SCENARIO` names as the provider and its `Decoder`, on whatever clock runs it, from the moment
 * the layer is built. A written scenario polls its slate at that moment as a frame, never pushes, and provides its own
 * decoder, which reads such a poll back as its league's `Listing`. A recorded one polls the recorded poll current at
 * that moment, received now, and pushes its recorded live feed frames at their recorded offsets; it needs the
 * `Decoder` of the provider that recorded them and provides that one on, so the layer both needs and provides
 * `Decoder`. Either is polled again at its next frame's time, and at least every 10 seconds, so a live game never goes
 * stale between frames. A name that is unset or unknown fails, listing the known ones.
 */
export const layer: Layer.Layer<
  Provider | Decoder,
  ScenarioUnknown | ScenarioUnreadable,
  HubConfig | RecordedScenarios | Decoder
> = Layer.unwrap(
  Effect.gen(function* () {
    const { scenario } = yield* HubConfig
    const recordedScenarios = yield* RecordedScenarios
    const start = yield* DateTime.now
    const name = Option.getOrElse(scenario, () => "")
    const written = scenarios.get(name)
    if (written !== undefined) {
      yield* Effect.logInfo(`ScenarioProvider: playing ${name}, ${written.frames.length} written frames`)
      const { provider, decoder } = playedWritten(written, start)
      return Layer.mergeAll(Layer.succeed(Provider, provider), Layer.succeed(Decoder, decoder))
    }
    const recorded = yield* recordedScenarios
      .load(name)
      .pipe(
        Effect.catchTag("ScenarioUnknown", ({ known }) =>
          Effect.fail(new ScenarioUnknown({ name, known: [...scenarios.keys(), ...known] }))
        )
      )
    yield* Effect.logInfo(`ScenarioProvider: playing ${name}, ${recorded.frames.length} recorded frames`)
    return Layer.mergeAll(
      Layer.succeed(Provider, playedRecorded(recorded, start)),
      Layer.succeed(Decoder, yield* Decoder)
    )
  })
)

function playedWritten(scenario: Scenario, start: DateTime.Utc) {
  return ofSlates(
    (league) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          scenario.slateAt(start, DateTime.distance(start, now)).filter((game) => game.league === league)
        ),
        Effect.withSpan("ScenarioProvider.poll", { attributes: { "sportal.league": league } })
      ),
    pollingAt(
      scenario.frames.map(({ at }) => at),
      start
    )
  )
}

/**
 * A provider whose poll of a league is `games(league)` as a frame, the games as JSON for its body, which never pushes
 * and is polled on `polling`; and the decoder that reads such a poll back as its league's `Listing`.
 */
function ofSlates(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>,
  polling: Polling
) {
  return {
    provider: Provider.of({
      poll: (league) =>
        Effect.all({ games: games(league), receivedAt: DateTime.now }).pipe(
          Effect.map(
            ({ games, receivedAt }): FeedFrame => ({
              receivedAt,
              feed: "poll",
              channel: league,
              kind: "response",
              body: encodeGames(games)
            })
          )
        ),
      push: () => Stream.never,
      polling
    }),
    decoder: Decoder.of({
      decode: (frames) =>
        frames.pipe(
          Stream.map(
            (frame) =>
              new Decoded({
                seq: frame.seq,
                at: frame.receivedAt,
                deliveries: Option.match(
                  Option.all({ league: decodeLeague(frame.channel), games: decodeGames(frame.body) }),
                  {
                    onNone: () => [],
                    onSome: ({ league, games }) => [Delivery.cases.Listing.make({ league, games })]
                  }
                ),
                resyncs: [],
                notices: []
              })
          )
        )
    })
  }
}

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

const Games = Schema.fromJsonString(Schema.Array(GameSnapshot))
const encodeGames = Schema.encodeSync(Games)
const decodeGames = Schema.decodeUnknownOption(Games)
const decodeLeague = Schema.decodeUnknownOption(LeagueId)
