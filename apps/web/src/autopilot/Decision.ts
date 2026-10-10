import type { GameId } from "@sportal/domain/Game"
import { Data, type DateTime, type Duration, type Option } from "effect"
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
 * each part, with the ranking it saw.
 */
export type Decision = Data.TaggedEnum<{
  Off: object
  Frozen: object
  Stepped: {
    readonly ranking: ReadonlyArray<Ranked>
    readonly layout: LayoutDecision
    readonly main: MainDecision
    readonly sound: SoundDecision
  }
}>
export const Decision = Data.taggedEnum<Decision>()
