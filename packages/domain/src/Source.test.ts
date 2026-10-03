import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option } from "effect"
import { type Broadcast, Network } from "./Game.ts"
import {
  type Airing,
  ChannelAvailability,
  type ChannelCarriage,
  ChannelId,
  ChannelLineup,
  Guide
} from "./Source.ts"
import { broadcast, snapshot, team } from "./TestGame.ts"

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

describe("Guide#availabilityOf", () => {
  const readAt = DateTime.makeUnsafe("2026-10-03T20:25:00Z")
  const news3 = ChannelId.make("UCPc5PkgTSfcJCi3-dJyg3Tg")
  const nflStCbs = ChannelId.make("UCquxTSBuMAzHJT_n09tNU6Q")
  const abc13 = ChannelId.make("UCTmlvooJJXQtAMVKowcFrVw")
  const accNetwork = ChannelId.make("UCdj7clRJstl32igUku_7Jaw")
  const news3Live = {
    _tag: "WebView" as const,
    url: "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"
  }
  const guide = new Guide({
    source: "YouTube TV",
    readAt,
    channels: [
      { id: news3, name: "News 3", live: news3Live },
      { id: nflStCbs, name: "NFL ST - CBS" },
      // ACC Network comes first, so a tie with no network to go on takes it.
      {
        id: accNetwork,
        name: "ACC Network",
        live: { _tag: "WebView", url: "https://tv.youtube.com/watch/acc" }
      },
      { id: abc13, name: "ABC 13", live: { _tag: "WebView", url: "https://tv.youtube.com/watch/abc" } }
    ],
    airings: [
      airing(news3, "Ohio State at Iowa", "2026-10-03T19:35:00Z", "2026-10-03T23:00:00Z"),
      airing(news3, "Ohio State at Iowa", "2026-10-04T09:00:00Z", "2026-10-04T12:00:00Z"),
      airing(
        nflStCbs,
        "New England Patriots at Buffalo Bills",
        "2026-10-04T17:00:00Z",
        "2026-10-04T20:00:00Z"
      ),
      airing(accNetwork, "Miami at Clemson", "2026-10-03T23:30:00Z", "2026-10-04T03:00:00Z"),
      airing(abc13, "Miami at Clemson", "2026-10-03T23:30:00Z", "2026-10-04T03:00:00Z"),
      airing(abc13, "Arkansas at Texas A&M", "2026-10-03T20:45:00Z", "2026-10-03T23:30:00Z")
    ]
  })
  const ohioStateAtIowa = snapshot({
    status: "live",
    kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
    away: {
      team: team("OSU", "fbs", {
        name: "Ohio State Buckeyes",
        location: "Ohio State",
        shortName: "Ohio State"
      }),
      score: 0
    },
    home: {
      team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa", shortName: "Iowa" }),
      score: 0
    },
    broadcasts: [broadcast("CBS")]
  })
  const miamiAtClemson = (broadcasts: Array<Broadcast>) =>
    snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T23:30:00Z"),
      away: { team: team("MIA", "fbs", { name: "Miami Hurricanes", location: "Miami" }), score: 0 },
      home: { team: team("CLEM", "fbs", { name: "Clemson Tigers", location: "Clemson" }), score: 0 },
      broadcasts
    })

  it("is carried on the channel airing the game, at the channel's live address", () => {
    assert.deepStrictEqual(
      guide.availabilityOf(ohioStateAtIowa),
      ChannelAvailability.Carried({
        channel: { name: "News 3", source: "YouTube TV", locator: news3Live },
        learnedFor: Option.none()
      })
    )
  })

  it("is carried on a live channel when the airing begins within 30 minutes of the reading", () => {
    const arkansasAtTexasAM = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T20:45:00Z"),
      away: { team: team("ARK", "fbs", { name: "Arkansas Razorbacks", location: "Arkansas" }), score: 0 },
      home: { team: team("TA&M", "fbs", { name: "Texas A&M Aggies", location: "Texas A&M" }), score: 0 },
      broadcasts: [broadcast("ESPN2")]
    })
    assert.strictEqual(guide.availabilityOf(arkansasAtTexasAM)._tag, "Carried")
  })

  it("is upcoming, naming the channel, when the channel is off the air", () => {
    const patriotsAtBills = snapshot({
      league: "nfl",
      kickoff: DateTime.makeUnsafe("2026-10-04T17:00:00Z"),
      away: {
        team: team("NE", "nfl", {
          name: "New England Patriots",
          location: "New England",
          shortName: "Patriots"
        }),
        score: 0
      },
      home: {
        team: team("BUF", "nfl", { name: "Buffalo Bills", location: "Buffalo", shortName: "Bills" }),
        score: 0
      },
      broadcasts: [broadcast("CBS")]
    })
    assert.deepStrictEqual(
      guide.availabilityOf(patriotsAtBills),
      ChannelAvailability.Upcoming({
        channel: Option.some("NFL ST - CBS"),
        begin: Option.some(DateTime.makeUnsafe("2026-10-04T17:00:00Z"))
      })
    )
  })

  it("is upcoming on a live channel when the airing is more than 30 minutes away", () => {
    assert.deepStrictEqual(
      guide.availabilityOf(miamiAtClemson([broadcast("ABC")])),
      ChannelAvailability.Upcoming({
        channel: Option.some("ABC 13"),
        begin: Option.some(DateTime.makeUnsafe("2026-10-03T23:30:00Z"))
      })
    )
  })

  it("takes the first matching airing in the guide when no channel is named for the game's networks", () => {
    const upcoming = guide.availabilityOf(miamiAtClemson([]))
    assert.deepStrictEqual(
      upcoming._tag === "Upcoming" ? upcoming.channel : upcoming,
      Option.some("ACC Network")
    )
  })

  it("matches an airing on now for a game under way, however late it began", () => {
    const delayed = snapshot({ ...ohioStateAtIowa, kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })
    assert.strictEqual(guide.availabilityOf(delayed)._tag, "Carried")
  })

  it("does not match a replay hours from kickoff", () => {
    const scheduled = snapshot({
      ...ohioStateAtIowa,
      status: "scheduled",
      kickoff: DateTime.makeUnsafe("2026-10-04T14:00:00Z")
    })
    assert.deepStrictEqual(
      guide.availabilityOf(scheduled),
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
  })

  it("does not match a title naming only one of the teams", () => {
    const iowaAtKansas = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
      away: ohioStateAtIowa.home,
      home: { team: team("KU", "fbs", { name: "Kansas Jayhawks", location: "Kansas" }), score: 0 },
      broadcasts: [broadcast("CBS")]
    })
    assert.deepStrictEqual(
      guide.availabilityOf(iowaAtKansas),
      ChannelAvailability.NotCarried({ why: "NotInGuide" })
    )
  })

  it("is not carried, streaming only, when every broadcast streams and no airing matches", () => {
    const onEspnPlus = snapshot({ kickoff: readAt, broadcasts: [broadcast("ESPN+", "streaming")] })
    assert.deepStrictEqual(
      guide.availabilityOf(onEspnPlus),
      ChannelAvailability.NotCarried({ why: "StreamingOnly" })
    )
  })

  it("is not carried, not in the guide, for a television game within reach that no airing matches", () => {
    const onCw = snapshot({ kickoff: readAt, broadcasts: [broadcast("CW")] })
    assert.deepStrictEqual(guide.availabilityOf(onCw), ChannelAvailability.NotCarried({ why: "NotInGuide" }))
  })

  it("is upcoming with nothing known for a kickoff past the guide's reach", () => {
    const tonight = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-04T00:00:00Z"),
      broadcasts: [broadcast("BTN")]
    })
    assert.deepStrictEqual(
      guide.availabilityOf(tonight),
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
  })
})

function lineup(carriages: ReadonlyArray<ChannelCarriage>) {
  return new ChannelLineup({ source: "YouTube TV", guide, carriages })
}

function on(...networks: Array<Network>) {
  return snapshot({ broadcasts: networks.map((network) => broadcast(network)) })
}

function airing(channel: ChannelId, title: string, begin: string, end: string): Airing {
  return { channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) }
}
