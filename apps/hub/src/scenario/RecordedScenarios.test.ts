import { readdirSync, readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { LiveGames } from "@sportal/domain/LiveGames"
import { polled } from "@sportal/domain/TestGame"
import type { Watchability } from "@sportal/domain/Watchability"
import { Array as Arr, DateTime, Duration, Option, Schema } from "effect"
import { Scenario } from "./Scenario.ts"

describe("Watchability over recorded game days", () => {
  it("finds the recorded scenarios", () => {
    assert.isAtLeast(recorded.length, 19)
  })

  it("is the same when a day is played twice", () => {
    assert.deepStrictEqual(
      recorded.flatMap((scenario) =>
        Arr.zip(played(scenario), played(scenario)).flatMap(([first, second]) =>
          isDeepStrictEqual(first.watchability, second.watchability)
            ? []
            : [`${scenario.name} ${instantOf(first.now)}: judged differently the second time`]
        )
      ),
      []
    )
  })

  it("scores a game that is not being played 0", () => {
    assert.deepStrictEqual(
      breaches(({ game, watchability }) =>
        game.progress() !== "live" && watchability.score !== 0
          ? Option.some(`scored ${watchability.score} while ${game.status}`)
          : Option.none()
      ),
      []
    )
  })

  it("never puts a college overtime in a lull for its clock alone", () => {
    assert.deepStrictEqual(
      breaches(({ game, watchability, now }) =>
        game.status === "live" &&
        game.league === "fbs" &&
        game.period >= 5 &&
        watchability.lull &&
        watchability.breakUntil === undefined &&
        DateTime.toEpochMillis(now) - DateTime.toEpochMillis(watchability.activeAt) < 60_000
          ? Option.some(`in a lull at ${game.clock} in college overtime`)
          : Option.none()
      ),
      []
    )
  })
})

const scenarios = new URL("../../../../fixtures/scenarios/", import.meta.url)
const recorded = readdirSync(scenarios)
  .filter((file) => file.endsWith(".json"))
  .map((file) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(Scenario))(readFileSync(new URL(file, scenarios), "utf8"))
  )

/** Each frame of a scenario with the watchability folded up to it, judged at `origin + at`. */
function played(scenario: Scenario) {
  return Arr.scan<
    Scenario["frames"][number],
    {
      readonly now: DateTime.Utc
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly fold: LiveGames
    }
  >(scenario.frames, { now: scenario.origin, slate: [], fold: LiveGames.empty }, (previous, frame) => {
    const now = DateTime.addDuration(scenario.origin, Duration.millis(frame.at))
    return { now, slate: frame.slate, fold: polled(previous.fold, frame.slate, now) }
  })
    .slice(1)
    .map(({ now, slate, fold }) => ({
      now,
      slate,
      watchability: slate.map((game) => fold.watchabilityOf(game, now))
    }))
}

/** Every game at every frame of every recorded scenario that `breach` names a breach for, one line each. */
function breaches(
  breach: (judged: {
    game: GameSnapshot
    watchability: Watchability
    now: DateTime.Utc
  }) => Option.Option<string>
): ReadonlyArray<string> {
  return recorded.flatMap((scenario) =>
    played(scenario).flatMap(({ now, slate, watchability }) =>
      Arr.getSomes(
        Arr.zip(slate, watchability).map(([game, judged]) =>
          Option.map(
            breach({ game, watchability: judged, now }),
            (line) => `${scenario.name} ${instantOf(now)} ${game.id}: ${line}`
          )
        )
      )
    )
  )
}

function instantOf(now: DateTime.Utc): string {
  return DateTime.formatIso(now).replace(/\.\d{3}Z$/, "Z")
}
