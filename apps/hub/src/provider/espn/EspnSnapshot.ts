import { GameStatus } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Situation as DomainSituation } from "@sportal/domain/Situation"
import { TeamId } from "@sportal/domain/Team"
import { Schema, SchemaGetter } from "effect"

/** ESPN's status type, as the site scoreboard and FastCast both spell it, read as a `GameStatus`. */
export const Status = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["pre", "in", "post"])
}).pipe(
  Schema.decodeTo(GameStatus, {
    decode: SchemaGetter.transform(statusOf),
    encode: SchemaGetter.forbidden(() => "A GameStatus cannot be encoded back to ESPN's status type")
  })
)

/** A competitor's score, as both feeds spell it: digits, or nothing before kickoff, which reads as 0. */
export const Score = Schema.String.pipe(
  Schema.decodeTo(Schema.Int, {
    decode: SchemaGetter.transform((score) => Number.parseInt(score, 10) || 0),
    encode: SchemaGetter.transform(String)
  })
)

/** ESPN's situation, as the site scoreboard and FastCast both spell it. */
export const Situation = Schema.Struct({
  possession: Schema.optional(Schema.String),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  isRedZone: Schema.optional(Schema.Boolean),
  homeTimeouts: Schema.optional(Schema.Int),
  awayTimeouts: Schema.optional(Schema.Int),
  lastPlay: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) }))
})

/** The domain `Situation`; the league and the home team's id orient its possession and yard line. */
export function situation(league: LeagueId, raw: typeof Situation.Type, homeTeamId: string): DomainSituation {
  return new DomainSituation({
    isRedZone: raw.isRedZone ?? false,
    homeTimeouts: raw.homeTimeouts ?? 0,
    awayTimeouts: raw.awayTimeouts ?? 0,
    ...(raw.possession === undefined ? {} : { possession: TeamId.make(`${league}:${raw.possession}`) }),
    // ESPN reports down -1 between plays (after a score, before a kickoff).
    ...(raw.down === undefined || raw.down < 1 ? {} : { down: raw.down }),
    ...(raw.distance === undefined ? {} : { distance: raw.distance }),
    // ESPN counts the yard line from the home goal line; the domain counts it to the goal the team with
    // the ball attacks. Without a team on the ball it cannot be oriented.
    ...(raw.yardLine === undefined || raw.possession === undefined
      ? {}
      : { yardLine: raw.possession === homeTeamId ? 100 - raw.yardLine : raw.yardLine }),
    ...(raw.lastPlay?.text === undefined ? {} : { lastPlay: raw.lastPlay.text })
  })
}

function statusOf(type: { readonly name: string; readonly state: "pre" | "in" | "post" }): GameStatus {
  switch (type.name) {
    case "STATUS_HALFTIME":
      return "halftime"
    case "STATUS_DELAYED":
      return "delayed"
    case "STATUS_POSTPONED":
      return "postponed"
    case "STATUS_CANCELED":
      return "canceled"
  }
  return type.state === "pre" ? "scheduled" : type.state === "in" ? "live" : "final"
}
