import type { LeagueId } from "@sportal/domain/League"
import { Play, PlayId, Timeout } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { type DateTime, Effect, Schema, SchemaGetter } from "effect"
import type { ArchivedPlay } from "../../corpus/Archive.ts"
import { teamId } from "./EspnEvent.ts"
import * as EspnPlay from "./EspnPlay.ts"

/**
 * ESPN's game summary, read as its plays with their wallclocks; a play without one is not read. A timeout says who
 * called it (its `team`, and `timeoutBy`) when its text names one of the header's teams: by a code ("Timeout #1 by NE at 03:27.") or a school's name
 * ("Timeout Georgia, clock 02:05"), matched across the game (`callers`). One that names neither is logged and says no
 * caller; one no team called (an official's) says none, unlogged.
 */
export function plays(
  league: LeagueId,
  summary: unknown
): Effect.Effect<ReadonlyArray<ArchivedPlay>, Schema.SchemaError> {
  return decodeSummary[league](summary).pipe(
    Effect.tap(({ uncalled }) =>
      uncalled.length === 0
        ? Effect.void
        : Effect.logWarning(
            `EspnSummary: ${league} timeouts ${uncalled.join(", ")} name neither team as their caller; counted for neither`
          )
    ),
    Effect.map(({ plays }) => plays)
  )
}

// A summary's play refers to a team by its `id`, ESPN's id for it.
const TeamRef = Schema.Struct({ id: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ id }) => id),
    encode: SchemaGetter.transform((id) => ({ id }))
  })
)

// A play as a summary's drive lists it: its team is the one with the ball as it ended, as FastCast's entity has it.
const SummaryPlay = Schema.Struct({
  ...EspnPlay.fields(TeamRef),
  wallclock: Schema.optional(Schema.DateTimeUtcFromString)
})

// A team as a summary's header lists it: ESPN's id, its abbreviation, and the names its timeouts may call it by.
const Competitor = Schema.Struct({
  id: Schema.String,
  team: Schema.Struct({
    abbreviation: Schema.String,
    location: Schema.optional(Schema.String),
    nickname: Schema.optional(Schema.String),
    shortDisplayName: Schema.optional(Schema.String),
    displayName: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String)
  })
})

// What a summary has of its plays: each drive's, and each play's win probability by its id. A summary without drives
// has no plays.
const Raw = Schema.Struct({
  drives: Schema.optional(
    Schema.Struct({
      previous: Schema.Array(Schema.Struct({ plays: Schema.optional(Schema.Array(SummaryPlay)) }))
    })
  ),
  winprobability: Schema.optional(
    Schema.Array(Schema.Struct({ playId: Schema.String, homeWinPercentage: Schema.Finite }))
  ),
  header: Schema.optional(
    Schema.Struct({
      competitions: Schema.Array(
        Schema.Struct({
          competitors: Schema.Array(Competitor)
        })
      )
    })
  )
})

// The plays read, and the timeouts among them whose caller did not read.
const Read = Schema.Struct({
  plays: Schema.Array(
    Schema.Struct({
      play: Schema.toType(Play),
      wallclock: Schema.toType(Schema.DateTimeUtcFromString),
      timeoutBy: Schema.optionalKey(TeamId)
    })
  ),
  uncalled: Schema.Array(PlayId)
})

function Summary(league: LeagueId) {
  return Raw.pipe(
    Schema.decodeTo(Read, {
      decode: SchemaGetter.transformEffect(({ drives, winprobability, header }) => {
        const probabilities = new Map(
          (winprobability ?? []).map(({ playId, homeWinPercentage }) => [playId, homeWinPercentage])
        )
        const wallclocked = (drives?.previous ?? [])
          .flatMap((drive) => drive.plays ?? [])
          .flatMap(({ wallclock, ...play }) => (wallclock === undefined ? [] : [{ play, wallclock }]))
        const competitors = (header?.competitions ?? []).flatMap(({ competitors }) => competitors)

        return Effect.forEach(wallclocked, ({ play, wallclock }) =>
          Effect.map(
            EspnPlay.read(league, {
              ...play,
              team: play.end.team,
              homeWinProbability: probabilities.get(play.id)
            }),
            (read) => ({ play: read, wallclock })
          )
        ).pipe(Effect.map((plays) => called(league, competitors, plays)))
      }),
      encode: SchemaGetter.forbidden(() => "Plays cannot be encoded back to an ESPN game summary")
    })
  )
}

/**
 * The plays in `Play.order`, each timeout with the team that called it, when its text names one of `competitors`, as
 * its `team` and `timeoutBy`; and the timeouts whose caller did not read.
 */
function called(
  league: LeagueId,
  competitors: ReadonlyArray<typeof Competitor.Type>,
  plays: ReadonlyArray<{ readonly play: Play; readonly wallclock: DateTime.Utc }>
): typeof Read.Type {
  const read = plays
    .toSorted((a, b) => Play.order(a.play, b.play))
    .map((read) => ({
      read,
      caller: Play.guards.Timeout(read.play) ? callerOf(read.play.text) : undefined
    }))
  const teamOf = callers(
    league,
    competitors,
    read.flatMap(({ caller }) => (caller === undefined ? [] : [caller]))
  )
  const withCallers = read.map(({ read, caller }) => {
    const timeoutBy = caller === undefined ? undefined : teamOf(caller)
    if (timeoutBy === undefined || !Play.guards.Timeout(read.play)) return { read, caller }
    const timeout = new Timeout({ ...read.play, team: timeoutBy })
    return { read: { ...read, play: timeout, timeoutBy }, caller }
  })

  return {
    plays: withCallers.map(({ read }) => read),
    // A timeout no team called (an official's) is not one a caller is missing from.
    uncalled: withCallers.flatMap(({ read, caller }) =>
      caller !== undefined && caller._tag !== "Nobody" && !("timeoutBy" in read) ? [read.play.id] : []
    )
  }
}

// Who a timeout's text says called it: a code ("Timeout #1 by NE at 03:27."), a school or club by name ("Timeout
// Georgia, clock 02:05"), no team (an official or TV timeout), or none of those.
type Caller =
  | { readonly _tag: "Code"; readonly code: string }
  | { readonly _tag: "Name"; readonly name: string }
  | { readonly _tag: "Nobody" }
  | { readonly _tag: "Unread" }

function callerOf(text: string): Caller {
  const code = /\bby ([A-Z0-9&]+)\b/.exec(text)?.[1]
  if (code !== undefined) return { _tag: "Code", code }
  const name = /^Timeout ([^,#]+?), clock\b/.exec(text)?.[1]
  if (name !== undefined) return { _tag: "Name", name }
  return /\b(official|tv|media)\b/i.test(text) ? { _tag: "Nobody" } : { _tag: "Unread" }
}

/**
 * The header team each of a game's callers names, where one step gives a unique answer, in order: a code that is a
 * team's abbreviation; a name that is a team's place or name, in any case; when exactly one code is left and exactly
 * one team was never named, the one is the other (the NFL's BLT for the header's BAL, HST for HOU); and a code still
 * left whose letters are in order in exactly one team's place (CLV in Cleveland). Any other caller names no team.
 */
function callers(
  league: LeagueId,
  competitors: ReadonlyArray<typeof Competitor.Type>,
  said: ReadonlyArray<Caller>
): (caller: Caller) => TeamId | undefined {
  const teams = competitors.map(({ id, team }) => ({
    id: teamId(league, id),
    abbreviation: team.abbreviation,
    place: (team.location ?? "").toLowerCase(),
    names: [team.location, team.nickname, team.shortDisplayName, team.displayName, team.name].flatMap(
      (name) => (name === undefined ? [] : [name.toLowerCase()])
    )
  }))
  const only = <A>(found: ReadonlyArray<A>) => (found.length === 1 ? found[0] : undefined)
  const byName = (name: string) => only(teams.filter(({ names }) => names.includes(name.toLowerCase())))
  const placed = (
    codes: ReadonlyArray<string>,
    teamOf: (code: string) => (typeof teams)[number] | undefined
  ) =>
    codes.flatMap((code) => {
      const team = teamOf(code)
      return team === undefined ? [] : [[code, team] as const]
    })

  const codes = [...new Set(said.flatMap((caller) => (caller._tag === "Code" ? [caller.code] : [])))]
  const abbreviated = placed(codes, (code) => only(teams.filter(({ abbreviation }) => abbreviation === code)))
  const named = new Set([
    ...abbreviated.map(([, team]) => team),
    ...said.flatMap((caller) => (caller._tag === "Name" ? [byName(caller.name)] : []))
  ])
  const left = codes.filter((code) => !abbreviated.some(([placedCode]) => placedCode === code))
  const unnamed = teams.filter((team) => !named.has(team))
  const eliminated = left.length === 1 && unnamed.length === 1 ? placed(left, () => unnamed[0]) : []
  const spelled = placed(
    left.filter((code) => !eliminated.some(([placedCode]) => placedCode === code)),
    (code) => only(teams.filter(({ place }) => inOrder(code.toLowerCase(), place)))
  )
  const byCode = new Map([...abbreviated, ...eliminated, ...spelled])
  return (caller) =>
    caller._tag === "Code"
      ? byCode.get(caller.code)?.id
      : caller._tag === "Name"
        ? byName(caller.name)?.id
        : undefined
}

// Whether every letter of `letters` is in `word`, in order.
function inOrder(letters: string, word: string): boolean {
  return (
    [...letters].reduce((from, letter) => (from < 0 ? from : word.indexOf(letter, from) + 1 || -1), 0) >= 0
  )
}
const decodeSummary = {
  nfl: Schema.decodeUnknownEffect(Summary("nfl")),
  fbs: Schema.decodeUnknownEffect(Summary("fbs"))
}
