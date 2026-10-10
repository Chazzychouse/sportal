import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { GameId } from "@sportal/domain/Game"
import { Moment } from "@sportal/domain/Moment"
import { Order, Schema } from "effect"

const ranks = ["redZone", "crunchTime", "bigPlay", "live", "break", "notLive"] as const

/** How worth showing a game is now: a red zone, crunch time, a big play, live play, a break, not live. */
export const Rank = Schema.Literals(ranks)
export type Rank = typeof Rank.Type

/** A moment's rank; a game with no classification counts as live. */
export function rankOf(moment: Moment | undefined): Rank {
  if (moment === undefined) return "live"
  return Moment.match(moment, {
    ScoringThreat: () => "redZone",
    CrunchTime: () => "crunchTime",
    BigPlay: () => "bigPlay",
    Live: () => "live",
    Break: () => "break",
    Upcoming: () => "notLive",
    Final: () => "notLive"
  })
}

/** Whether a game in `rank` is in play: any rank above a break. */
export function isLive(rank: Rank): boolean {
  return outranks(rank, "break")
}

/** Whether `a` is a strictly higher rank than `b`. */
export function outranks(a: Rank, b: Rank): boolean {
  return ranks.indexOf(a) < ranks.indexOf(b)
}

/** The best first: the higher rank, then the higher score, then the lower tile. */
export function byRank(
  classifications: SlateChanged["classifications"]
): Order.Order<{ readonly tile: number; readonly game: GameId }> {
  return Order.combine(
    Order.mapInput(Order.Number, ({ game }) => ranks.indexOf(rankOf(classifications[game]?.moment))),
    Order.combine(
      Order.mapInput(Order.Number, ({ game }) => -(classifications[game]?.score ?? 0)),
      Order.mapInput(Order.Number, ({ tile }) => tile)
    )
  )
}

/** A rank as people read it. */
export function label(rank: Rank): string {
  return labels[rank]
}

const labels = {
  redZone: "red zone",
  crunchTime: "crunch time",
  bigPlay: "big play",
  live: "live",
  break: "on a break",
  notLive: "not live"
} satisfies Record<Rank, string>
