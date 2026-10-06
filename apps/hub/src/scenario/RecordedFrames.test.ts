import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { LiveGames } from "@sportal/domain/LiveGames"
import { polled } from "@sportal/domain/TestGame"
import { DateTime, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { Frame } from "../Frame.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { RecordedScenario } from "./RecordedScenario.ts"
import { Scenario } from "./Scenario.ts"

describe("the recorded slices as raw frames", () => {
  it.effect("there is a frames file for every JSON slice", () =>
    Effect.gen(function* () {
      const { slices, framed } = yield* inFolder
      assert.isNotEmpty(slices)
      assert.sameMembers(framed, slices)
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect(
    "each frames file plays to its JSON slice's final slate",
    () =>
      Effect.gen(function* () {
        const { slices } = yield* inFolder
        for (const name of slices) {
          const slice = yield* sliceOf(name)
          const fromSlice = slice.frames
            .reduce(
              (fold, frame) =>
                polled(fold, frame.slate, DateTime.add(slice.origin, { milliseconds: frame.at })),
              LiveGames.empty
            )
            .slate(LeagueId.literals)
          const fromFrames = (yield* foldedFrom(name)).slate(LeagueId.literals)

          assert.isNotEmpty(fromSlice, name)
          assert.deepStrictEqual(fromFrames.map(compared), fromSlice.map(compared), name)
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000
  )

  it.effect(
    "every frames file decodes with no frame or event left undecoded",
    () =>
      Effect.gen(function* () {
        const { slices } = yield* inFolder
        for (const name of slices) {
          const undecoded = (yield* decodedFrom(name)).flatMap((said) =>
            said._tag === "Noted" &&
            (said.notice._tag === "FrameUndecoded" || said.notice._tag === "EventUndecoded")
              ? [said.notice._tag]
              : []
          )
          assert.deepStrictEqual(undecoded, [], name)
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000
  )
})

const inFolder = Effect.gen(function* () {
  const files = yield* (yield* FileSystem.FileSystem).readDirectory(RecordedScenario.folder)
  return {
    slices: files
      .filter((file) => /^[a-z0-9-]+\.json$/.test(file))
      .map((file) => file.slice(0, -".json".length)),
    framed: files
      .filter((file) => file.endsWith(".frames.jsonl.gz"))
      .map((file) => file.slice(0, -".frames.jsonl.gz".length))
  }
})

function sliceOf(name: string) {
  return Effect.gen(function* () {
    const { join } = yield* Path.Path
    return yield* (yield* FileSystem.FileSystem)
      .readFileString(join(RecordedScenario.folder, `${name}.json`))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Scenario))))
  })
}

function decodedFrom(name: string) {
  return Effect.gen(function* () {
    const { frames } = yield* RecordedScenario.load(name)
    return yield* EspnDecode.decode(
      Stream.fromIterable(frames.map((frame, index) => new Frame({ ...frame, seq: index + 1 })))
    ).pipe(Stream.runCollect)
  })
}

/** The fold after every delivery the frames give, each taken at its frame's receipt. */
function foldedFrom(name: string) {
  return Effect.flatMap(decodedFrom(name), (said) =>
    Effect.reduce(
      said,
      () => LiveGames.empty,
      (fold, one) =>
        one._tag === "Delivered"
          ? fold
              .step(Option.some(one.delivery), one.at, Option.some(one.seq))
              .pipe(Effect.map(({ next }) => next))
          : Effect.succeed(fold)
    )
  )
}

/** What a decoder change since the slices were cut cannot move. */
function compared(game: GameSnapshot) {
  return {
    id: game.id,
    status: game.status,
    period: game.period,
    clock: game.clock,
    home: game.home.score,
    away: game.away.score,
    possession: game.situation?.possession,
    down: game.situation?.down,
    distance: game.situation?.distance,
    yardLine: game.situation?.yardLine
  }
}
