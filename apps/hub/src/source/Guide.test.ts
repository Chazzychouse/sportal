import { assert, describe, it } from "@effect/vitest"
import { type Broadcast, Network } from "@sportal/domain/Game"
import type { Team } from "@sportal/domain/Team"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Option } from "effect"
import { type Airing, ChannelId, Guide } from "./Guide.ts"

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
  const live = ChannelId.make("live-1")
  const onLiveChannel = (airings: Array<Airing>) =>
    new Guide({
      source: "YouTube TV",
      readAt,
      channels: [
        { id: live, name: "Live 1", live: { _tag: "WebView", url: "https://tv.youtube.com/watch/live1" } }
      ],
      airings
    })
  const nfl = (away: Team, home: Team) =>
    snapshot({
      league: "nfl",
      status: "live",
      kickoff: readAt,
      away: { team: away, score: 0 },
      home: { team: home, score: 0 },
      broadcasts: [broadcast("FOX")]
    })
  const miamiAtClemson = (broadcasts: Array<Broadcast>) =>
    snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T23:30:00Z"),
      away: { team: team("MIA", "fbs", { name: "Miami Hurricanes", location: "Miami" }), score: 0 },
      home: { team: team("CLEM", "fbs", { name: "Clemson Tigers", location: "Clemson" }), score: 0 },
      broadcasts
    })
  const airingBeginning = (begin: DateTime.Utc) =>
    onLiveChannel([
      { channel: live, title: "Ohio State at Iowa", begin, end: DateTime.add(begin, { hours: 3 }) }
    ])

  const baseballGuide = () =>
    onLiveChannel([
      airing(live, "St. Louis Cardinals at Chicago Cubs", "2026-10-03T20:30:00Z", "2026-10-03T23:30:00Z"),
      airing(live, "New York Yankees vs. Tampa Bay Rays", "2026-10-03T20:30:00Z", "2026-10-03T23:30:00Z")
    ])

  it("should be carried on the channel airing the game, at the channel's live address", () => {
    const availability = guide.availabilityOf(ohioStateAtIowa, readAt)

    assert.deepStrictEqual(availability, {
      _tag: "Carried",
      channel: { name: "News 3", source: "YouTube TV", locator: news3Live }
    })
  })

  it("should be upcoming on a live channel while the game has not started, however soon its airing begins", () => {
    const arkansasAtTexasAM = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T20:45:00Z"),
      away: { team: team("ARK", "fbs", { name: "Arkansas Razorbacks", location: "Arkansas" }), score: 0 },
      home: { team: team("TA&M", "fbs", { name: "Texas A&M Aggies", location: "Texas A&M" }), score: 0 },
      broadcasts: [broadcast("ESPN2")]
    })

    const availability = guide.availabilityOf(arkansasAtTexasAM, readAt)

    assert.strictEqual(availability._tag, "Upcoming")
  })

  it("should be upcoming, naming the channel, when the channel is off the air", () => {
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

    const availability = guide.availabilityOf(patriotsAtBills, readAt)

    assert.deepStrictEqual(availability, {
      _tag: "Upcoming",
      channel: Option.some("NFL ST - CBS"),
      begin: Option.some(DateTime.makeUnsafe("2026-10-04T17:00:00Z"))
    })
  })

  it("should be upcoming on a live channel when the airing is hours away", () => {
    const availability = guide.availabilityOf(miamiAtClemson([broadcast("ABC")]), readAt)

    assert.deepStrictEqual(availability, {
      _tag: "Upcoming",
      channel: Option.some("ABC 13"),
      begin: Option.some(DateTime.makeUnsafe("2026-10-03T23:30:00Z"))
    })
  })

  it("should take the first matching airing in the guide when no channel is named for the game's networks", () => {
    const upcoming = guide.availabilityOf(miamiAtClemson([]), readAt)

    assert.deepStrictEqual(
      upcoming._tag === "Upcoming" ? upcoming.channel : upcoming,
      Option.some("ACC Network")
    )
  })

  it("should match an airing on now for a game under way, however late it began", () => {
    const delayed = snapshot({ ...ohioStateAtIowa, kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })

    const availability = guide.availabilityOf(delayed, readAt)

    assert.strictEqual(availability._tag, "Carried")
  })

  it("should match an airing on now for a game delayed mid-game", () => {
    const delayed = snapshot({
      ...ohioStateAtIowa,
      status: "delayed",
      period: 3,
      kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z")
    })

    const availability = guide.availabilityOf(delayed, readAt)

    assert.strictEqual(availability._tag, "Carried")
  })

  it("should not match a replay hours from kickoff", () => {
    const scheduled = snapshot({
      ...ohioStateAtIowa,
      status: "scheduled",
      kickoff: DateTime.makeUnsafe("2026-10-04T14:00:00Z")
    })

    const availability = guide.availabilityOf(scheduled, readAt)

    assert.deepStrictEqual(availability, { _tag: "Upcoming", channel: Option.none(), begin: Option.none() })
  })

  it("should not match a title naming only one of the teams", () => {
    const iowaAtKansas = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
      away: ohioStateAtIowa.home,
      home: { team: team("KU", "fbs", { name: "Kansas Jayhawks", location: "Kansas" }), score: 0 },
      broadcasts: [broadcast("CBS")]
    })

    const availability = guide.availabilityOf(iowaAtKansas, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should not carry a game, streaming only, when every broadcast streams and no airing matches", () => {
    const onEspnPlus = snapshot({ kickoff: readAt, broadcasts: [broadcast("ESPN+", "streaming")] })

    const availability = guide.availabilityOf(onEspnPlus, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "StreamingOnly" })
  })

  it("should not carry a television game within reach that no airing matches, as not in the guide", () => {
    const onCw = snapshot({ kickoff: readAt, broadcasts: [broadcast("CW")] })

    const availability = guide.availabilityOf(onCw, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should not match a baseball airing between teams from the same places as Arizona and Chicago, for the Cardinals at the Bears", () => {
    const cardinalsAtBears = nfl(
      team("ARI", "nfl", { name: "Arizona Cardinals", location: "Arizona", shortName: "Cardinals" }),
      team("CHI", "nfl", { name: "Chicago Bears", location: "Chicago", shortName: "Bears" })
    )

    const availability = baseballGuide().availabilityOf(cardinalsAtBears, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should not match a baseball airing between teams from the same places as New York and Tampa Bay, for the Jets at the Buccaneers", () => {
    const jetsAtBuccaneers = nfl(
      team("NYJ", "nfl", { name: "New York Jets", location: "New York", shortName: "Jets" }),
      team("TB", "nfl", { name: "Tampa Bay Buccaneers", location: "Tampa Bay", shortName: "Buccaneers" })
    )

    const availability = baseballGuide().availabilityOf(jetsAtBuccaneers, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should not match an airing that has ended", () => {
    const ended = onLiveChannel([
      airing(live, "Ohio State at Iowa", "2026-10-03T17:00:00Z", "2026-10-03T20:25:00Z")
    ])
    const earlier = snapshot({ ...ohioStateAtIowa, kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })

    const availability = ended.availabilityOf(earlier, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should match an airing beginning exactly 45 minutes from kickoff", () => {
    const kickoff = DateTime.add(readAt, { hours: 1 })
    const scheduled = snapshot({ ...ohioStateAtIowa, status: "scheduled", kickoff })
    const atTolerance = DateTime.add(kickoff, { minutes: 45 })

    const availability = airingBeginning(atTolerance).availabilityOf(scheduled, readAt)

    assert.deepStrictEqual(availability, {
      _tag: "Upcoming",
      channel: Option.some("Live 1"),
      begin: Option.some(atTolerance)
    })
  })

  it("should not match an airing beginning just over 45 minutes from kickoff", () => {
    const kickoff = DateTime.add(readAt, { hours: 1 })
    const scheduled = snapshot({ ...ohioStateAtIowa, status: "scheduled", kickoff })
    const justOver = DateTime.add(kickoff, { minutes: 45, seconds: 1 })

    const availability = airingBeginning(justOver).availabilityOf(scheduled, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should be carried on a live channel once the game has started", () => {
    const started = snapshot({ ...ohioStateAtIowa, status: "live", kickoff: readAt })

    const availability = airingBeginning(readAt).availabilityOf(started, readAt)

    assert.strictEqual(availability._tag, "Carried")
  })

  it("should be upcoming on a live channel at its airing's begin while the game has not started", () => {
    const scheduled = snapshot({ ...ohioStateAtIowa, status: "scheduled", kickoff: readAt })

    const availability = airingBeginning(readAt).availabilityOf(scheduled, readAt)

    assert.strictEqual(availability._tag, "Upcoming")
  })

  it("should not carry an unmatched kickoff exactly at the guide's reach", () => {
    const atReach = snapshot({ kickoff: DateTime.add(readAt, { hours: 3 }), broadcasts: [broadcast("BTN")] })

    const availability = guide.availabilityOf(atReach, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should be upcoming for an unmatched kickoff just past the guide's reach", () => {
    const pastReach = snapshot({
      kickoff: DateTime.add(readAt, { hours: 3, seconds: 1 }),
      broadcasts: [broadcast("BTN")]
    })

    const availability = guide.availabilityOf(pastReach, readAt)

    assert.deepStrictEqual(availability, { _tag: "Upcoming", channel: Option.none(), begin: Option.none() })
  })

  it("should not carry a game with no broadcasts that no airing matches, as not in the guide", () => {
    const unlisted = snapshot({ kickoff: readAt, broadcasts: [] })

    const availability = guide.availabilityOf(unlisted, readAt)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should be upcoming with nothing known for a kickoff past the guide's reach", () => {
    const tonight = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-04T00:00:00Z"),
      broadcasts: [broadcast("BTN")]
    })

    const availability = guide.availabilityOf(tonight, readAt)

    assert.deepStrictEqual(availability, { _tag: "Upcoming", channel: Option.none(), begin: Option.none() })
  })
})

describe("Guide#availabilityOf on a channel that carries a network", () => {
  const kickoff = DateTime.makeUnsafe("2026-10-09T00:15:00Z")
  const primeVideo = ChannelId.make("primevideo")
  const primeVideoLive = { _tag: "WebView" as const, url: "https://player.twitch.tv/?channel=primevideo" }
  const lineup = new Guide({
    source: "Twitch",
    readAt: DateTime.makeUnsafe(0),
    channels: [
      { id: primeVideo, name: "Prime Video", live: primeVideoLive, network: Network.make("Prime Video") }
    ],
    airings: []
  })
  const thursdayNight = snapshot({
    league: "nfl",
    kickoff,
    broadcasts: [broadcast("Prime Video", "streaming")]
  })

  it("should be carried on the network's channel once the game has started", () => {
    const started = snapshot({ ...thursdayNight, status: "live" })

    const availability = lineup.availabilityOf(started, kickoff)

    assert.deepStrictEqual(availability, {
      _tag: "Carried",
      channel: { name: "Prime Video", source: "Twitch", locator: primeVideoLive }
    })
  })

  it("should be upcoming on the network's channel at kickoff until the game has started, even past its kickoff", () => {
    const now = DateTime.add(kickoff, { minutes: 5 })

    const availability = lineup.availabilityOf(thursdayNight, now)

    assert.deepStrictEqual(availability, {
      _tag: "Upcoming",
      channel: Option.some("Prime Video"),
      begin: Option.some(kickoff)
    })
  })

  it("should not carry a game that is over on the network's channel", () => {
    const over = snapshot({ ...thursdayNight, status: "final" })

    const availability = lineup.availabilityOf(over, DateTime.add(kickoff, { hours: 4 }))

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "StreamingOnly" })
  })

  it("should not carry a game of a network no channel carries", () => {
    const onPeacock = snapshot({ league: "nfl", kickoff, broadcasts: [broadcast("Peacock", "streaming")] })

    const availability = lineup.availabilityOf(onPeacock, kickoff)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "StreamingOnly" })
  })

  it("should not be upcoming past its reach when the guide lists no airings", () => {
    const tomorrow = snapshot({ kickoff: DateTime.add(kickoff, { days: 1 }), broadcasts: [broadcast("CBS")] })

    const availability = lineup.availabilityOf(tomorrow, kickoff)

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })

  it("should take an airing that names the game over a channel that carries its network", () => {
    const live = ChannelId.make("live-1")
    const liveAddress = { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/live1" }
    const both = new Guide({
      source: "YouTube TV",
      readAt: kickoff,
      channels: [
        { id: primeVideo, name: "Prime Video", live: primeVideoLive, network: Network.make("Prime Video") },
        { id: live, name: "Live 1", live: liveAddress }
      ],
      airings: [airing(live, "AWAY at HOME", "2026-10-09T00:15:00Z", "2026-10-09T03:30:00Z")]
    })

    const availability = both.availabilityOf(snapshot({ ...thursdayNight, status: "live" }), kickoff)

    assert.deepStrictEqual(availability, {
      _tag: "Carried",
      channel: { name: "Live 1", source: "YouTube TV", locator: liveAddress }
    })
  })
})

describe("Guide#availabilityOf at a time after its reading", () => {
  it("should not match an airing that ended after the guide was read", () => {
    const readAt = DateTime.makeUnsafe("2026-10-03T20:25:00Z")
    const live = ChannelId.make("live-1")
    const guide = new Guide({
      source: "YouTube TV",
      readAt,
      channels: [
        { id: live, name: "Live 1", live: { _tag: "WebView", url: "https://tv.youtube.com/watch/live1" } }
      ],
      airings: [airing(live, "AWAY at HOME", "2026-10-03T17:00:00Z", "2026-10-03T20:35:00Z")]
    })
    const game = snapshot({ status: "live", kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })

    const availability = guide.availabilityOf(game, DateTime.add(readAt, { minutes: 20 }))

    assert.deepStrictEqual(availability, { _tag: "NotCarried", why: "NotInGuide" })
  })
})

function airing(channel: ChannelId, title: string, begin: string, end: string): Airing {
  return { channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) }
}
