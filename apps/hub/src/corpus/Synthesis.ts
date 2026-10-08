import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Situation } from "@sportal/domain/Situation"
import type { TeamId } from "@sportal/domain/Team"
import { Array as Arr, DateTime, Duration, type Effect, Option, Order, Stream } from "effect"
import type { GameArchive, PlayArchive } from "../provider/Archiver.ts"
import { Decoded } from "../provider/Provider.ts"
import { Delivery, type DeliverySource } from "../slate/Delivery.ts"
import { CorpusLine } from "./CorpusLine.ts"

/**
 * A backfilled day's poll and push lines from its archived games, in arrival order, with synthetic seqs.
 *
 * The push gives each game as scheduled at kickoff less 30 minutes, then each play `lag.push` after it was run: its
 * plays so far, and the snapshot it leaves (`snapshotAfter`). The poll lists each league every 10 s from the first
 * kickoff less 30 minutes until the first poll at or after the last play is `lag.poll` old, each game as the snapshot
 * its last play `lag.poll` old or older left, or as scheduled before any. Frames are numbered from 1 by arrival, a push
 * before a poll at one instant, and turned into lines by `CorpusLine.ofDecoded`, as a captured day's are.
 */
export function day(games: ReadonlyArray<GameArchive>): Effect.Effect<{
  readonly poll: ReadonlyArray<CorpusLine>
  readonly push: ReadonlyArray<CorpusLine>
}> {
  const timelines = games.map((game) => ({
    game,
    played: game.plays.map((archived, i, plays) => ({
      archived,
      snapshot: snapshotAfter(game, archived, plays.slice(0, i + 1))
    }))
  }))
  const pushes = timelines.flatMap(({ game, played }) => [
    {
      at: DateTime.subtractDuration(game.scheduled.kickoff, pregame),
      source: "push" as const,
      deliveries: [Delivery.cases.Snapshot.make({ snapshot: game.scheduled, from: "push" })]
    },
    ...played.map(({ archived, snapshot }, i) => ({
      at: DateTime.addDuration(archived.wallclock, lag.push),
      source: "push" as const,
      deliveries: [
        Delivery.cases.Plays.make({
          game: game.final.id,
          plays: played.slice(0, i + 1).map(({ archived }) => archived.play)
        }),
        Delivery.cases.Snapshot.make({ snapshot, from: "push" })
      ]
    }))
  ])
  const leagues = [...new Set(games.map(({ final }) => final.league))].toSorted()
  const polls = pollInstants(games).map((at) => ({
    at,
    source: "poll" as const,
    deliveries: leagues.map((league) =>
      Delivery.cases.Listing.make({
        league,
        games: timelines
          .filter(({ game }) => game.final.league === league)
          .map(
            ({ game, played }) =>
              played.findLast(({ archived }) =>
                DateTime.isLessThanOrEqualTo(DateTime.addDuration(archived.wallclock, lag.poll), at)
              )?.snapshot ?? game.scheduled
          )
      })
    )
  }))
  const frames = [...pushes, ...polls]
    .toSorted(pushFirst)
    .map(({ at, deliveries }, i) => new Decoded({ seq: i + 1, at, deliveries, observations: [] }))
  return CorpusLine.ofDecoded(Stream.fromIterable(frames))
}

/** How long after a play is run each feed shows it, on a backfilled day: ADR 0007's medians. */
const lag = { push: Duration.seconds(28), poll: Duration.seconds(41) } as const

/** How long before kickoff a backfilled game is first pushed and the day's polls begin. */
const pregame = Duration.minutes(30)

/** Between two polls. */
const pollEvery = Duration.seconds(10)

/** Earlier first, and a push before a poll at one instant; otherwise as made. */
const pushFirst: Order.Order<{ readonly at: DateTime.Utc; readonly source: DeliverySource }> = Order.Struct({
  at: DateTime.Order,
  source: Order.mapInput(Order.Number, (source: DeliverySource) => sourceRank[source])
})

const sourceRank: Record<DeliverySource, number> = { push: 0, poll: 1 }

/** Timeouts each team has in a half. */
const halfTimeouts = 3

/** Each team's timeouts in overtime: the NFL's for the whole overtime, college's for each overtime period. */
const overtimeTimeouts: Record<LeagueId, { readonly timeouts: number; readonly per: "overtime" | "period" }> =
  {
    nfl: { timeouts: 2, per: "overtime" },
    fbs: { timeouts: 1, per: "period" }
  }

/**
 * The game as `archived`, the last of `played`, left it: `final`'s teams, rankings, and broadcasts at the play's period, clock,
 * and scores; halftime after the play that ends the second period, final after the last play, live otherwise; its
 * situation from the play's end spot, each team's timeouts its allowance less those it called in the half.
 */
function snapshotAfter(
  game: GameArchive,
  { play }: PlayArchive,
  played: ReadonlyArray<PlayArchive>
): GameSnapshot {
  const { final } = game
  const { end } = play
  const half = halfOf(final.league, play.period)
  const left = (team: TeamId) =>
    Math.max(
      0,
      half.timeouts -
        played.filter(
          ({ play: called }) =>
            Play.guards.Timeout(called) &&
            called.team === team &&
            halfOf(final.league, called.period).half === half.half
        ).length
    )
  return new GameSnapshot({
    ...final,
    status:
      played.length === game.plays.length
        ? "final"
        : Play.guards.PeriodEnd(play) && play.period === 2
          ? "halftime"
          : "live",
    period: play.period,
    clock: play.clock,
    home: { ...final.home, score: play.homeScore },
    away: { ...final.away, score: play.awayScore },
    situation: new Situation({
      possession: end.team,
      down: end.down,
      distance: end.distance,
      yardLine: end.yardsToEndzone,
      homeTimeouts: left(final.home.team.id),
      awayTimeouts: left(final.away.team.id),
      lastPlay: play.text
    })
  })
}

/** Which half `period` is in (each overtime period its own in college) and the timeouts a team has in it. */
function halfOf(league: LeagueId, period: number): { readonly half: number; readonly timeouts: number } {
  if (period <= 4) return { half: period <= 2 ? 1 : 2, timeouts: halfTimeouts }
  const { timeouts, per } = overtimeTimeouts[league]
  return { half: per === "overtime" ? 5 : period, timeouts }
}

/** Every 10 s from the first kickoff less `pregame` up to the first instant at or after the last play is `lag.poll` old. */
function pollInstants(games: ReadonlyArray<GameArchive>): ReadonlyArray<DateTime.Utc> {
  if (!Arr.isReadonlyArrayNonEmpty(games)) return []
  const first = Arr.min(
    Arr.map(games, ({ scheduled }) => DateTime.subtractDuration(scheduled.kickoff, pregame)),
    DateTime.Order
  )
  const last = Arr.max(
    Arr.map(games, (game) =>
      DateTime.addDuration(
        Option.match(Arr.last(game.plays), {
          onNone: () => game.scheduled.kickoff,
          onSome: ({ wallclock }) => wallclock
        }),
        lag.poll
      )
    ),
    DateTime.Order
  )
  return Arr.unfold(first, (at) =>
    DateTime.isLessThan(at, DateTime.addDuration(last, pollEvery))
      ? Option.some([at, DateTime.addDuration(at, pollEvery)] as const)
      : Option.none()
  )
}
