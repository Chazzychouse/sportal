import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { ChannelAvailability, type ChannelCarriage, ChannelLineup } from "./Channel.ts"
import { Network } from "./Game.ts"
import { broadcast, snapshot } from "./TestGame.ts"

const espn = Network.make("ESPN")
const disney = Network.make("Disney+")
const espnPlus = Network.make("ESPN+")
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const espnChannel = {
  name: "ESPN",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const carried = { _tag: "Carried" as const, network: espn, channel: espnChannel }
const notCarried = (network: Network) => ({
  _tag: "NotCarried" as const,
  network,
  source: "YouTube TV" as const
})

describe("ChannelLineup#availabilityOf", () => {
  it("is carried when the network has a channel", () => {
    assert.deepStrictEqual(
      lineup([carried]).availabilityOf(on(espn)),
      ChannelAvailability.Carried({ channel: espnChannel, learnedFor: Option.some(espn) })
    )
  })

  it("is unlearned when nothing is recorded for the network", () => {
    assert.deepStrictEqual(
      lineup([]).availabilityOf(on(espn)),
      ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
    )
  })

  it("prefers a carried network over an earlier unlearned one", () => {
    assert.strictEqual(lineup([carried]).availabilityOf(on(disney, espn))._tag, "Carried")
  })

  it("asks about the first network with nothing recorded, skipping ones not carried", () => {
    assert.deepStrictEqual(
      lineup([notCarried(espnPlus)]).availabilityOf(on(espnPlus, disney, espn)),
      ChannelAvailability.Unlearned({ network: disney, source: "YouTube TV", guide })
    )
  })

  it("is not carried when every network is not carried", () => {
    assert.deepStrictEqual(
      lineup([notCarried(espnPlus)]).availabilityOf(on(espnPlus)),
      ChannelAvailability.NotCarried({ why: "NoStream" })
    )
  })

  it("is not carried when the game lists no networks", () => {
    assert.deepStrictEqual(
      lineup([carried]).availabilityOf(on()),
      ChannelAvailability.NotCarried({ why: "NoStream" })
    )
  })
})

describe("ChannelLineup#record and #forget", () => {
  it("replaces an earlier carriage for the same network", () => {
    assert.deepStrictEqual(lineup([carried]).record(notCarried(espn)).carriages, [notCarried(espn)])
  })

  it("forgets one network's carriage and keeps the others", () => {
    assert.deepStrictEqual(lineup([carried, notCarried(espnPlus)]).forget(espn).carriages, [
      notCarried(espnPlus)
    ])
  })
})

function lineup(carriages: ReadonlyArray<ChannelCarriage>) {
  return new ChannelLineup({ source: "YouTube TV", guide, carriages })
}

function on(...networks: Array<Network>) {
  return snapshot({ broadcasts: networks.map((network) => broadcast(network)) })
}
