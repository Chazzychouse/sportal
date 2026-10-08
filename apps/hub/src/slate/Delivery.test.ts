import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { Schema } from "effect"
import { Delivery } from "./Delivery.ts"

const wire = Schema.fromJsonString(Delivery)

describe("Delivery", () => {
  it.each([
    ["Listing", Delivery.cases.Listing.make({ league: "fbs", games: [snapshot(), liveSnapshot()] })],
    ["Snapshot", Delivery.cases.Snapshot.make({ snapshot: liveSnapshot() })],
    ["Plays", Delivery.cases.Plays.make({ game: GameId.make("401"), plays: [play()] })]
  ])("should round-trip a %s through its wire form", (_name, delivery) => {
    const encoded = Schema.encodeSync(wire)(delivery)

    const decoded = Schema.decodeSync(wire)(encoded)

    assert.deepStrictEqual(decoded, delivery)
  })

  it("should match on its tag", () => {
    const delivery = Delivery.cases.Plays.make({ game: GameId.make("401"), plays: [play()] })

    const matched = Delivery.match(delivery, {
      Listing: () => "listing",
      Snapshot: () => "snapshot",
      Plays: () => "plays"
    })

    assert.strictEqual(matched, "plays")
  })
})
