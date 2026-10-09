import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, Record, Schema } from "effect"
import { EspnEvent } from "./EspnEvent.ts"
import { Scoreboard } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"

/**
 * Each league's decode of what ESPN sends for it: an event of either feed, a play entity, and the site scoreboard's JSON.
 * `EspnState` folds frames through these.
 */
export const byLeague: { readonly [L in LeagueId]: ReturnType<typeof leagueDecode> } = {
  nfl: leagueDecode("nfl"),
  fbs: leagueDecode("fbs")
}

function leagueDecode(league: LeagueId) {
  return {
    decodeEvent: Schema.decodeUnknownEffect(EspnEvent(league)),
    decodePlay: Schema.decodeUnknownEffect(EspnPlay.FootballPlay(league)),
    decodeScoreboard: Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))
  }
}

/** The events as games; an event that does not decode is skipped, and the rest still delivered. */
export const gamesOf = Effect.fnUntraced(function* (league: LeagueId, events: ReadonlyArray<unknown>) {
  const decoded = yield* Effect.forEach(events, (event) => Effect.option(byLeague[league].decodeEvent(event)))
  return Arr.getSomes(decoded)
})

/** The game's plays, in `Play.order`; a play that does not decode is skipped. */
export const playsOf = Effect.fnUntraced(function* (
  league: LeagueId,
  entities: Readonly<Record<string, Schema.Json>>
) {
  const decoded = yield* Effect.forEach(Record.values(entities), (entity) =>
    Effect.option(byLeague[league].decodePlay(entity))
  )
  return Arr.getSomes(decoded).toSorted(Play.order)
})
