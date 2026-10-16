import { assert, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import * as TestGame from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { GamesQuery } from "./GamesQuery.ts"
import type { ListedGame } from "./ListedGame.ts"

describe("GamesQuery.answer", () => {
  it("should keep only the leagues asked for", () => {
    const games = [listed("1", { league: "nfl" }), listed("2", { league: "fbs" })]

    const answer = GamesQuery.answer({ league: ["nfl"] }, games)

    assert.deepStrictEqual(ids(answer), ["1"])
  })

  it("should keep only the progress asked for", () => {
    const games = [listed("1", { status: "live", period: 1 }), listed("2", { status: "final" })]

    const answer = GamesQuery.answer({ progress: ["over"] }, games)

    assert.deepStrictEqual(ids(answer), ["2"])
  })

  it("should keep only games a source carries or will carry when asked", () => {
    const games = [listed("1", {}, [carried]), listed("2", {}, [{ _tag: "NotCarried", why: "NotInGuide" }])]

    const answer = GamesQuery.answer({ carried: "true" }, games)

    assert.deepStrictEqual(ids(answer), ["1"])
  })

  it("should put live games first, then upcoming by start, then over", () => {
    const games = [
      listed("over", { status: "final" }),
      listed("later", { startsAt: DateTime.makeUnsafe("2026-10-03T20:00:00Z") }),
      listed("live", { status: "live", period: 2 }),
      listed("sooner", { startsAt: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })
    ]

    const answer = GamesQuery.answer({}, games)

    assert.deepStrictEqual(ids(answer), ["live", "sooner", "later", "over"])
  })
})

const carried: ChannelAvailability = {
  _tag: "Carried",
  channel: {
    name: "News 3",
    source: "YouTube TV",
    locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/x" }
  }
}

function listed(
  id: string,
  overrides: Parameters<typeof TestGame.snapshot>[0],
  availability: ReadonlyArray<ChannelAvailability> = []
): ListedGame {
  return { snapshot: TestGame.snapshot({ id: GameId.make(id), ...overrides }), availability }
}

function ids(games: ReadonlyArray<ListedGame>): ReadonlyArray<string> {
  return games.map(({ snapshot }) => snapshot.id)
}
