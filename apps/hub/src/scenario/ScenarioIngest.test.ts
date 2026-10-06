import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { LiveGames } from "../LiveGames.ts"
import { Scenario } from "./Scenario.ts"
import * as ScenarioClock from "./ScenarioClock.ts"
import * as ScenarioIngest from "./ScenarioIngest.ts"

describe("ScenarioIngest", () => {
  it.effect("each league's listing reaches the fold at its scenario time", () =>
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      yield* TestClock.adjust(0)
      assert.lengthOf(yield* listed(liveGames, "fbs"), 4)
      assert.deepStrictEqual(yield* listed(liveGames, "nfl"), [])
      assert.isTrue(Option.isNone((yield* liveGames.latest).seq), "a scenario has no feed log")

      yield* TestClock.adjust("119 seconds")
      assert.isFalse(yield* tieInRedZone(liveGames))
      yield* TestClock.adjust("1 second")
      assert.isTrue(yield* tieInRedZone(liveGames))
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("plays a recorded slice from its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const slice = Scenario.build("slice", [
        {
          id: "9",
          home: "UGA",
          away: "ALA",
          timeline: [["0:00", { status: "live", period: 1, clock: "15:00" }]]
        }
      ])
      yield* fs.writeFileString(
        join(dir, "slice.json"),
        yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(slice)
      )

      const games = yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        return yield* listed(yield* LiveGames, "fbs")
      }).pipe(Effect.provide(playing("slice", dir)))
      assert.deepStrictEqual(
        games.map((game) => game.id),
        ["9"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("plays every slice committed in the folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const names = (yield* fs.readDirectory(Scenario.folder))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
      assert.isAbove(names.length, 0)
      yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(0)
            const liveGames = yield* LiveGames
            const games = [...(yield* listed(liveGames, "fbs")), ...(yield* listed(liveGames, "nfl"))]
            assert.isAbove(games.length, 0, `${name} has games at its start`)
          }).pipe(Effect.provide(playing(name)), Effect.scoped),
        { discard: true }
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect(
    "lists between frames and after the last, so a live game stays live through a gap and after the end",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const gap = Scenario.build("gap", [
          {
            id: "9",
            home: "UGA",
            away: "ALA",
            timeline: [
              ["0:00", { status: "live", period: 1, clock: "15:00" }],
              ["2:30", { clock: "14:00" }]
            ]
          }
        ])
        yield* fs.writeFileString(
          join(dir, "gap.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(gap)
        )

        yield* Effect.gen(function* () {
          const liveGames = yield* LiveGames
          const state = Effect.map(liveGames.latest, (folded) =>
            Option.map(Option.fromNullishOr(folded.live.get(GameId.make("9"))), (held) => held.state._tag)
          )
          yield* TestClock.adjust(0)
          yield* TestClock.adjust("2 minutes")
          assert.deepStrictEqual(yield* state, Option.some("Live"))

          yield* TestClock.adjust("30 seconds")
          assert.strictEqual((yield* listed(liveGames, "fbs"))[0]?.clock, "14:00")
          yield* TestClock.adjust("31 minutes")
          assert.deepStrictEqual(yield* state, Option.some("Live"))
        }).pipe(Effect.provide(playing("gap", dir)))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails to load a slice that no longer decodes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        join(dir, "stale.json"),
        JSON.stringify({ name: "stale", origin: 7, frames: [] })
      )
      const exit = yield* Layer.build(playing("stale", dir)).pipe(Effect.exit)
      assert.isTrue(exit._tag === "Failure")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a name it does not know, listing the names it does", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const error = yield* Layer.build(playing("../../etc/passwd", dir)).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error.message, "two-minute-drill-tie")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("plays at the scenario's speed, while the rest of the Hub keeps real time", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        playing("two-minute-drill-tie").pipe(Layer.provide(ScenarioClock.layer(10)))
      )
      // 13 real seconds are 130 scenario seconds: the drive is at the 17, in the red zone, since 2:00.
      yield* TestClock.adjust("13 seconds")
      assert.isTrue(yield* tieInRedZone(Context.get(context, LiveGames)))
      assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), 13_000)
    }).pipe(Effect.scoped)
  )
})

/** Scenario `name` (from `from`, when given) played into a fold, which is also provided to the test. */
function playing(name: string, from?: string) {
  return ScenarioIngest.layer(name, from).pipe(
    Layer.provideMerge(LiveGames.layer),
    Layer.provide(NodeServices.layer)
  )
}

/** League `league`'s last listing in the fold. */
function listed(liveGames: LiveGames["Service"], league: LeagueId) {
  return Effect.map(liveGames.latest, (folded) => folded.listed.get(league) ?? [])
}

function tieInRedZone(liveGames: LiveGames["Service"]) {
  return Effect.map(
    listed(liveGames, "fbs"),
    (games) => games.find((game) => game.id === "tie-uga-ala")?.situation?.inRedZone() === true
  )
}
