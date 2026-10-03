import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Team, TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Provider, ProviderError } from "../provider/Provider.ts"
import { Ingest } from "./Ingest.ts"

function liveGame(homeScore: number) {
  const team = (abbreviation: string) =>
    new Team({ id: TeamId.make(`fbs:${abbreviation}`), abbreviation, name: abbreviation })
  return new GameSnapshot({
    id: GameId.make("1"),
    league: "fbs",
    kickoff: DateTime.makeUnsafe("2026-10-03T16:00:00Z"),
    status: "live",
    period: 1,
    clock: "10:00",
    home: { team: team("MSST"), score: homeScore },
    away: { team: team("ALA"), score: 0 },
    broadcasts: ["ESPN"]
  })
}

/** A provider that answers each poll with the next scripted response. */
function scripted(responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">) {
  let call = 0
  return Layer.succeed(
    Provider,
    Provider.of({
      slate: (league) => {
        const response = responses[Math.min(call++, responses.length - 1)]
        return response === "fail" || response === undefined
          ? Effect.fail(new ProviderError({ league, cause: "down" }))
          : Effect.succeed(response)
      }
    })
  )
}

describe("Ingest", () => {
  it.effect("polls again after the live cadence and publishes the new slate", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 7)
    }).pipe(
      Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted([[liveGame(0)], [liveGame(7)]]))))
    )
  )

  it.effect("keeps the last slate when the provider fails", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 7)
    }).pipe(Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted([[liveGame(7)], "fail"])))))
  )
})
