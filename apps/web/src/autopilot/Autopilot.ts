import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import { Array as Arr, Data, DateTime, Duration, Equal, Option, Result, Schema } from "effect"
import { LayoutName, Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { Decision, LayoutDecision, MainDecision, type Ranked, SoundDecision, StayReason } from "./Decision.ts"
import { fit, nextFit } from "./Fit.ts"
import { byRank, isLive, outranks, type Rank, rankOf } from "./Ranking.ts"

type Classifications = SlateChanged["classifications"]

/** What a command you send can make yours: the main tile, the sound or the layout. */
export type Part = "main" | "audio" | "layout"

/**
 * What the autopilot is doing, for its toggle to say: off, a part yours until a time, nothing live, or following the
 * main tile's game in its rank; `fitted` is the slot count of a layout fitted below the ceiling.
 */
export type AutopilotStatus = Data.TaggedEnum<{
  Off: object
  Yours: { readonly part: Part; readonly until: DateTime.Utc }
  NothingLive: { readonly fitted: Option.Option<number> }
  Following: { readonly game: GameId; readonly rank: Rank; readonly fitted: Option.Option<number> }
}>
export const AutopilotStatus = Data.taggedEnum<AutopilotStatus>()

/** One step: the next autopilot, the commands to send in order, and what it decided and why. */
export interface Step {
  readonly next: Autopilot
  readonly commands: ReadonlyArray<ScreenCommand>
  readonly decision: Decision
}

const Held = Schema.Struct({ game: GameId, since: Schema.DateTimeUtcFromString })
type Held = typeof Held.Type

/**
 * A Display's autopilot. While on, it fits the layout to the games worth showing, never past the ceiling (the layout
 * you chose), and shows the best game by the ranking in the main tile, the sound on it. The main tile's game holds
 * the tile for `dwell` against a game in a higher rank, and gives way at once when it stops. Each command you send
 * makes the part it touches yours for `suspension`. Pure.
 */
export class Autopilot extends Schema.Class<Autopilot>("sportal/Autopilot")({
  on: Schema.Boolean,
  /** The main tile's game at the last step, and since when it has held the tile. */
  main: Schema.OptionFromOptionalKey(Held),
  /** The layout you chose: the most the autopilot fits the layout to. */
  ceiling: Schema.OptionFromOptionalKey(LayoutName),
  /** Until when each part is yours. */
  suspended: Schema.Struct({
    main: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    audio: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    layout: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  })
}) {
  static readonly off: Autopilot = new Autopilot({
    on: false,
    main: Option.none(),
    ceiling: Option.none(),
    suspended: { main: Option.none(), audio: Option.none(), layout: Option.none() }
  })

  /** How long the main tile's game holds the tile against a game in a higher rank, unless it stops. */
  static readonly dwell = Duration.seconds(30)

  /** How long a command you send keeps the autopilot off the part it touched. */
  static readonly suspension = Duration.minutes(3)

  /** On, the ceiling taken from `screen`; or off, everything forgotten. The Screen is left as it is. */
  toggle(screen: Screen): Autopilot {
    return this.on
      ? Autopilot.off
      : new Autopilot({ ...Autopilot.off, on: true, ceiling: Option.some(screen.layout) })
  }

  /** After `command`, which you sent at `now`: the parts it touches are yours for `suspension`; a `SetLayout` sets the ceiling. */
  manual(command: ScreenCommand, now: DateTime.Utc): Autopilot {
    if (!this.on) return this
    const touched = suspends(command)
    const until = Option.some(DateTime.addDuration(now, Autopilot.suspension))
    const yours = (part: Part) => (touched.includes(part) ? until : this.suspended[part])
    return new Autopilot({
      ...this,
      ceiling: command._tag === "SetLayout" ? Option.some(command.layout) : this.ceiling,
      suspended: { main: yours("main"), audio: yours("audio"), layout: yours("layout") }
    })
  }

  /**
   * One step at `now` on `screen` with each game's classification: it fits the layout unless the layout is yours,
   * then, on the fitted Screen, steers the main tile unless it is yours, then the sound. Off or soloed, nothing. When
   * nothing changed, `next` is this autopilot.
   */
  step(screen: Screen, classifications: Classifications, now: DateTime.Utc): Step {
    if (!this.on) return { next: this, commands: [], decision: Decision.Off() }
    if (Option.isSome(screen.solo)) return { next: this, commands: [], decision: Decision.Frozen() }
    const suspended = {
      main: running(this.suspended.main, now),
      audio: running(this.suspended.audio, now),
      layout: running(this.suspended.layout, now)
    }

    const [layout, fitted] = steerLayout(screen, this.ceiling, suspended.layout, classifications, now)
    const afterFit = afterAll(screen, fitted)
    const held = heldIn(afterFit, this.main, now)
    const [main, promoted] = steerMain(afterFit, held, suspended.main, classifications, now)
    const afterMain = afterAll(afterFit, promoted)
    const [sound, focused] = steerSound(afterMain, afterFit.audioFocus, suspended.audio)

    const next = new Autopilot({ ...this, suspended, main: heldIn(afterMain, held, now) })
    return {
      next: unchangedOr(this, next),
      commands: [...fitted, ...promoted, ...focused],
      decision: Decision.Stepped({ ranking: rankingOf(afterFit, classifications), layout, main, sound })
    }
  }

  /**
   * When the next step may change something with no new slate: the main game's dwell ending, a suspension ending, or
   * the hold of a game over on a tile of `screen` running out.
   */
  nextDeadline(
    now: DateTime.Utc,
    screen: Screen,
    classifications: Classifications
  ): Option.Option<DateTime.Utc> {
    const times = [
      ...Option.toArray(Option.map(this.main, ({ since }) => DateTime.addDuration(since, Autopilot.dwell))),
      ...Option.toArray(this.suspended.main),
      ...Option.toArray(this.suspended.audio),
      ...Option.toArray(this.suspended.layout),
      ...(Option.isSome(this.ceiling) ? Option.toArray(nextFit(screen, classifications, now)) : [])
    ]
    return Arr.head(times.filter((time) => DateTime.isGreaterThan(time, now)).toSorted(DateTime.Order))
  }

  /** What it is doing at `now` on `screen`: a part yours (the main tile, the sound, then the layout), else what it follows. */
  status(now: DateTime.Utc, screen: Screen, classifications: Classifications): AutopilotStatus {
    if (!this.on) return AutopilotStatus.Off()
    for (const part of ["main", "audio", "layout"] as const) {
      const until = running(this.suspended[part], now)
      if (Option.isSome(until)) return AutopilotStatus.Yours({ part, until: until.value })
    }
    const fitted = Option.filter(this.ceiling, (ceiling) => ceiling !== screen.layout).pipe(
      Option.map(() => Screen.slotCount(screen.layout))
    )
    const game = gameIn(screen.tiles[0])
    const rank = game === undefined ? "notLive" : rankOf(classifications[game]?.moment)
    return game === undefined || !isLive(rank)
      ? AutopilotStatus.NothingLive({ fitted })
      : AutopilotStatus.Following({ game, rank, fitted })
  }
}

/** The layout fitted under `ceiling`, unless it is yours or there is none. */
function steerLayout(
  screen: Screen,
  ceiling: Option.Option<LayoutName>,
  yours: Option.Option<DateTime.Utc>,
  classifications: Classifications,
  now: DateTime.Utc
): readonly [LayoutDecision, ReadonlyArray<ScreenCommand>] {
  if (Option.isSome(yours)) return [LayoutDecision.Yours({ until: yours.value }), []]
  if (Option.isNone(ceiling)) return [LayoutDecision.NoCeiling(), []]
  const commands = fit(screen, ceiling.value, classifications, now)
  if (commands.length === 0) return [LayoutDecision.Kept({ layout: screen.layout }), []]
  return [LayoutDecision.Fitted({ from: screen.layout, to: afterAll(screen, commands).layout }), commands]
}

/**
 * The main tile, unless it is yours: the best game by the ranking takes it from a game that has stopped, or, after
 * the dwell, from a game in a lower rank. With no live game, nothing moves.
 */
function steerMain(
  screen: Screen,
  held: Option.Option<Held>,
  yours: Option.Option<DateTime.Utc>,
  classifications: Classifications,
  now: DateTime.Utc
): readonly [MainDecision, ReadonlyArray<ScreenCommand>] {
  const current = Option.map(held, ({ game }) => game)
  const stay = (why: StayReason): readonly [MainDecision, ReadonlyArray<ScreenCommand>] => [
    MainDecision.Stayed({ game: current, why }),
    []
  ]
  if (Option.isSome(yours)) return stay(StayReason.Yours({ until: yours.value }))

  const rank = (game: GameId) => rankOf(classifications[game]?.moment)
  const best = Arr.head(occupiedIn(screen.tiles).toSorted(byRank(classifications)))
  if (Option.isNone(best) || !isLive(rank(best.value.game))) return stay(StayReason.NothingLive())
  const { game, tile } = best.value
  if (Option.contains(current, game)) return stay(StayReason.Best())

  const promote = (why: "outranks" | "stopped"): readonly [MainDecision, ReadonlyArray<ScreenCommand>] => [
    MainDecision.Promoted({ game, over: current, why }),
    [{ _tag: "Promote", tile }]
  ]
  if (Option.isNone(held) || !isLive(rank(held.value.game))) return promote("stopped")
  if (!outranks(rank(game), rank(held.value.game))) return stay(StayReason.SameRank())
  const dwellEnd = DateTime.addDuration(held.value.since, Autopilot.dwell)
  return DateTime.isLessThan(now, dwellEnd)
    ? stay(StayReason.Dwell({ left: DateTime.distance(now, dwellEnd) }))
    : promote("outranks")
}

/**
 * The sound on the main tile's game; while the sound is yours, back on `heard` (the game it was on before the main
 * tile was steered) when a promote moved it and that game is still on screen.
 */
function steerSound(
  screen: Screen,
  heard: Option.Option<GameId>,
  yours: Option.Option<DateTime.Utc>
): readonly [SoundDecision, ReadonlyArray<ScreenCommand>] {
  if (Option.isSome(yours)) {
    const back = Option.flatMap(heard, (game) =>
      screen.hears(game) ? Option.none() : Option.fromUndefinedOr(screen.slotOf(game))
    )
    const commands: ReadonlyArray<ScreenCommand> = Option.match(back, {
      onNone: () => [],
      onSome: (tile) => [{ _tag: "FocusAudio", tile }]
    })
    return [SoundDecision.Yours({ until: yours.value }), commands]
  }
  const main = gameIn(screen.tiles[0])
  const commands: ReadonlyArray<ScreenCommand> =
    main === undefined || screen.hears(main) ? [] : [{ _tag: "FocusAudio", tile: 0 }]
  return [SoundDecision.OnMain({ game: Option.fromUndefinedOr(main) }), commands]
}

/** The main tile's game and since when it has held the tile: `held`'s while it is the same game, else from `now`. */
function heldIn(screen: Screen, held: Option.Option<Held>, now: DateTime.Utc): Option.Option<Held> {
  const game = gameIn(screen.tiles[0])
  if (game === undefined) return Option.none()
  return Option.exists(held, (was) => was.game === game) ? held : Option.some({ game, since: now })
}

/** Each occupied tile's game with its rank and score, best first. */
function rankingOf(screen: Screen, classifications: Classifications): ReadonlyArray<Ranked> {
  return occupiedIn(screen.tiles)
    .toSorted(byRank(classifications))
    .map(({ game }) => ({
      game,
      rank: rankOf(classifications[game]?.moment),
      score: classifications[game]?.score ?? 0
    }))
}

/** A suspension, while it still runs at `now`. */
function running(until: Option.Option<DateTime.Utc>, now: DateTime.Utc): Option.Option<DateTime.Utc> {
  return Option.filter(until, (time) => DateTime.isLessThan(now, time))
}

/** `current` when `next` is equal to it, so an idle step changes nothing; else `next`. */
function unchangedOr(current: Autopilot, next: Autopilot): Autopilot {
  return Equal.equals(current, next) ? current : next
}

/** The parts a command you send makes yours. */
function suspends(command: ScreenCommand): ReadonlyArray<Part> {
  switch (command._tag) {
    case "Promote":
      return ["main"]
    case "Solo":
      return ["main", "audio"]
    case "Swap":
      return command.a === 0 || command.b === 0 ? ["main"] : ["layout"]
    case "Assign":
    case "Clear":
      return command.tile === 0 ? ["main"] : ["layout"]
    case "FocusAudio":
      return ["audio"]
    case "SetLayout":
      return ["layout"]
    default:
      return []
  }
}

/** `screen` after the autopilot's own commands, none of which asks a game's availability. */
function afterAll(screen: Screen, commands: ReadonlyArray<ScreenCommand>): Screen {
  return commands.reduce(
    (current, command) =>
      Result.getOrElse(
        current.apply(command, () => []),
        () => current
      ),
    screen
  )
}

function occupiedIn(tiles: ReadonlyArray<Tile>) {
  return tiles.flatMap((tile, index) => (Tile.guards.Empty(tile) ? [] : [{ tile: index, game: tile.game }]))
}

function gameIn(tile: Tile | undefined): GameId | undefined {
  return tile === undefined || Tile.guards.Empty(tile) ? undefined : tile.game
}
