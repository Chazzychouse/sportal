import { NodeCrypto } from "@effect/platform-node"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import * as Database from "./Database.ts"
import type { Frame } from "./Frame.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import type { Provider } from "./provider/Provider.ts"
import { decodedFrames } from "./provider/TestProvider.ts"
import { Board } from "./slate/Board.ts"
import { BoardTelemetry } from "./slate/BoardTelemetry.ts"
import type { Delivery } from "./slate/Delivery.ts"
import { Slate } from "./slate/Slate.ts"
import type { SlateObservation } from "./slate/SlateObservation.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

/**
 * The board following a feed log in memory, which is provided too, for a test to append to. `frames` are logged
 * before the board starts, so they are replayed. Frames are read by the snapshot feed's decode unless
 * `options.provider` is given, told to the board's telemetry unless `options.telemetry` is, and the game day is read in
 * `options.zone`, the local one unless given.
 */
export function boardOver(
  frames: ReadonlyArray<Frame> = [],
  options: {
    readonly provider?: Layer.Layer<Provider>
    readonly telemetry?: Layer.Layer<BoardTelemetry>
    readonly zone?: DateTime.TimeZone
  } = {}
): Layer.Layer<Board | FeedLog> {
  return Board.layer.pipe(
    Layer.provideMerge(FeedLog.layerTest(frames)),
    Layer.provide([
      options.telemetry ?? BoardTelemetry.layer,
      options.provider ?? TestSnapshotFeed.layer,
      options.zone === undefined ? DateTime.layerCurrentZoneLocal : DateTime.layerCurrentZone(options.zone)
    ]),
    Layer.provide([Database.layerMemory, NodeCrypto.layer]),
    Layer.orDie
  )
}

/** The board's latest once `layer` is built. */
export function latestOf<E, R>(layer: Layer.Layer<Board, E, R>) {
  return Board.use((board) => board.latest).pipe(Effect.provide(layer))
}

/**
 * Runs `act`, then waits for the board to take or tick `count` times after the replay, and gives the last slate
 * taken.
 */
export const takingAfter = Effect.fnUntraced(function* <E, R>(
  count: number,
  act: Effect.Effect<unknown, E, R>
) {
  const board = yield* Board
  const taking = yield* board.taken.pipe(
    Stream.filter(({ replayed }) => !replayed),
    Stream.take(count),
    Stream.runFold(
      () => Slate.empty,
      (_, { taken }) => taken.next
    ),
    Effect.forkChild({ startImmediately: true })
  )

  yield* act
  return yield* Fiber.join(taking)
})

/** Appends `frame` to the feed log and gives the slate it took it into. */
export const appended = Effect.fnUntraced(function* (frame: Frame) {
  const feedLog = yield* FeedLog
  return yield* takingAfter(1, feedLog.append(frame))
})

/**
 * Appends a snapshot feed frame that says only `delivery`, received at `at` (the clock's now, unless given), and gives
 * the board's latest once it has taken it.
 */
export const delivered = Effect.fnUntraced(function* (delivery: Delivery, at?: DateTime.Utc) {
  const now = yield* DateTime.now
  return yield* appended(TestSnapshotFeed.framed(delivery, at ?? now))
})

/** The game events of every take after the replay, in order. */
export const liveEvents: Stream.Stream<GameEvent, never, Board> = Stream.unwrap(
  Board.use((board) =>
    Effect.succeed(
      board.taken.pipe(
        Stream.filter(({ replayed }) => !replayed),
        Stream.flatMap(({ taken }) => Stream.fromIterable(taken.events))
      )
    )
  )
)

/**
 * Every game event and observation the slate makes taking `frames` whole, in order, as the provided `Provider`'s
 * decode reads them.
 */
export const takenOf = Effect.fnUntraced(function* (frames: ReadonlyArray<Frame>) {
  const empty: {
    readonly slate: Slate
    readonly events: ReadonlyArray<GameEvent>
    readonly observations: ReadonlyArray<SlateObservation>
  } = { slate: Slate.empty, events: [], observations: [] }
  const decoded = yield* decodedFrames(frames)
  const { events, observations } = yield* Effect.reduce(
    decoded,
    () => empty,
    ({ slate, events, observations }, said) =>
      Effect.map(slate.take(said), (taken) => ({
        slate: taken.next,
        events: [...events, ...taken.events],
        observations: [...observations, ...taken.observations]
      }))
  )
  return { events, observations }
})
