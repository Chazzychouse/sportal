import { LeagueId } from "@sportal/domain/League"
import { Schema } from "effect"

/**
 * ESPN could not supply data: a poll of `league` unreachable or refused, or FastCast refused, closed, or gone silent
 * (FastCast serves every league, so it has none). `EspnProvider` and `FastCast` log and count it where it happens.
 */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Unreachable", "Refused", "Closed", "Silent"]),
  league: Schema.optional(LeagueId),
  cause: Schema.Defect()
}) {}
