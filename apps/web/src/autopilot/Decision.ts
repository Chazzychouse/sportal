import type { GameId } from "@sportal/domain/Game"
import { Data, type DateTime, Duration, Option } from "effect"
import type { LayoutName } from "../screen/Screen.ts"
import type { Rank } from "./Ranking.ts"

/** A game on a tile, with its rank and score, as a step saw it. */
export interface Ranked {
  readonly game: GameId
  readonly rank: Rank
  readonly score: number
}

/** What a step did with the layout: fitted it, kept it, left it to you, or had no ceiling to fit under. */
export type LayoutDecision = Data.TaggedEnum<{
  Fitted: { readonly from: LayoutName; readonly to: LayoutName }
  Kept: { readonly layout: LayoutName }
  Yours: { readonly until: DateTime.Utc }
  NoCeiling: object
}>
export const LayoutDecision = Data.taggedEnum<LayoutDecision>()

/** Why the main tile kept its game: it is the best, nothing ranks higher, its dwell, it is yours, or nothing is live. */
export type StayReason = Data.TaggedEnum<{
  Best: object
  SameRank: object
  Dwell: { readonly left: Duration.Duration }
  Yours: { readonly until: DateTime.Utc }
  NothingLive: object
}>
export const StayReason = Data.taggedEnum<StayReason>()

/** What a step did with the main tile: promoted a game over the one there, and why, or kept it, and why. */
export type MainDecision = Data.TaggedEnum<{
  Promoted: {
    readonly game: GameId
    readonly over: Option.Option<GameId>
    readonly why: "outranks" | "stopped"
  }
  Stayed: { readonly game: Option.Option<GameId>; readonly why: StayReason }
}>
export const MainDecision = Data.taggedEnum<MainDecision>()

/** Where a step left the sound: on the main tile's game, or yours. */
export type SoundDecision = Data.TaggedEnum<{
  OnMain: { readonly game: Option.Option<GameId> }
  Yours: { readonly until: DateTime.Utc }
}>
export const SoundDecision = Data.taggedEnum<SoundDecision>()

/**
 * What one step of the autopilot decided and why, for its log: off, frozen (the Screen soloed), or what it did with
 * each part, with the ranks it saw.
 */
export type Decision = Data.TaggedEnum<{
  Off: object
  Frozen: object
  Stepped: {
    readonly ranked: ReadonlyArray<Ranked>
    readonly layout: LayoutDecision
    readonly main: MainDecision
    readonly sound: SoundDecision
  }
}>
export const Decision = Data.taggedEnum<Decision>()

/**
 * A decision in words, `nameOf` naming each game. What changes from step to step while a decision stands (a dwell's
 * seconds, a suspension's end, the Rank) is left out, so two steps with the same words decided the same.
 */
export function explain(decision: Decision, nameOf: (game: GameId) => string): string {
  return Decision.$match(decision, {
    Off: () => "off",
    Frozen: () => "frozen: the Screen is soloed",
    Stepped: ({ layout, main, sound }) =>
      [mainWords(main, nameOf), layoutWords(layout), soundWords(sound)].join("; ")
  })
}

/** A decision's details for its log: the Rank it saw, best first, and how long a dwell has left. */
export function details(decision: Decision): Record<string, string | number> {
  if (!Decision.$is("Stepped")(decision)) return {}
  const { ranked, main } = decision
  const dwell =
    MainDecision.$is("Stayed")(main) && StayReason.$is("Dwell")(main.why)
      ? { "autopilot.dwellLeftSeconds": Math.ceil(Duration.toSeconds(main.why.left)) }
      : {}
  return {
    "autopilot.ranked": ranked.map(({ game, rank, score }) => `${game} ${rank} ${score}`).join(", "),
    ...dwell
  }
}

function mainWords(main: MainDecision, nameOf: (game: GameId) => string): string {
  const named = (game: Option.Option<GameId>, none: string) =>
    Option.match(game, { onNone: () => none, onSome: nameOf })
  return MainDecision.$match(main, {
    Promoted: ({ game, over, why }) =>
      `promoted ${nameOf(game)} over ${named(over, "an empty main tile")}: ${
        why === "outranks" ? "it ranks higher" : "the main tile's game stopped"
      }`,
    Stayed: ({ game, why }) =>
      `kept ${named(game, "the empty main tile")}: ${StayReason.$match(why, {
        Best: () => "it is the best",
        SameRank: () => "nothing ranks higher",
        Dwell: () => "holding for its dwell",
        Yours: () => "the main tile is yours",
        NothingLive: () => "nothing is live"
      })}`
  })
}

function layoutWords(layout: LayoutDecision): string {
  return LayoutDecision.$match(layout, {
    Fitted: ({ from, to }) => `layout ${from} to ${to}`,
    Kept: ({ layout }) => `layout ${layout}`,
    Yours: () => "layout yours",
    NoCeiling: () => "no ceiling"
  })
}

function soundWords(sound: SoundDecision): string {
  return SoundDecision.$match(sound, {
    OnMain: () => "sound on the main tile",
    Yours: () => "sound yours"
  })
}
