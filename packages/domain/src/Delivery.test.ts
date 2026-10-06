import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Delivery } from "./Delivery.ts"
import { GameId } from "./Game.ts"
import { liveSnapshot, play, snapshot } from "./TestGame.ts"

const wire = Schema.fromJsonString(Delivery)

describe("Delivery", () => {
  it.each([
    ["Listing", Delivery.cases.Listing.make({ league: "fbs", games: [snapshot(), liveSnapshot()] })],
    ["Snapshot", Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" })],
    ["Plays", Delivery.cases.Plays.make({ game: GameId.make("401"), plays: [play()] })]
  ])("round-trips a %s through its wire form", (_name, delivery) => {
    assert.deepStrictEqual(Schema.decodeSync(wire)(Schema.encodeSync(wire)(delivery)), delivery)
  })

  it("matches on its tag", () => {
    const delivery = Delivery.cases.Plays.make({ game: GameId.make("401"), plays: [play()] })
    assert.strictEqual(
      Delivery.match(delivery, {
        Listing: () => "listing",
        Snapshot: () => "snapshot",
        Plays: () => "plays"
      }),
      "plays"
    )
  })
})
