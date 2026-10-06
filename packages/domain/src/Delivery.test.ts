import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "./Delivery.ts"
import { GameId } from "./Game.ts"
import { snapshot } from "./TestGame.ts"

describe("Delivery", () => {
  it("matches each of its three cases", () => {
    const deliveries = [
      Delivery.Listing({ league: "fbs", games: [] }),
      Delivery.Snapshot({ snapshot: snapshot(), from: "poll" }),
      Delivery.Plays({ game: GameId.make("1"), plays: [] })
    ]
    const names = deliveries.map(
      Delivery.$match({ Listing: () => "listing", Snapshot: () => "snapshot", Plays: () => "plays" })
    )
    assert.deepStrictEqual(names, ["listing", "snapshot", "plays"])
  })
})
