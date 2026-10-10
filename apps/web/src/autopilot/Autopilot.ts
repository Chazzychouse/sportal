import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { Array as Arr, Data, DateTime, Duration, Option, Order, Result, Schema } from "effect"
import { type Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/** The two things the autopilot steers: the main tile and the sound. */
type Part = "main" | "audio"

/** What the autopilot is doing, for its toggle to say: off, idle, away on a game, or a part yours until a time. */
export type AutopilotStatus = Data.TaggedEnum<{
  Off: object
  Idle: object
  Away: { readonly part: Part; readonly game: GameId }
  Yours: { readonly part: Part; readonly until: DateTime.Utc }
}>
export const AutopilotStatus = Data.taggedEnum<AutopilotStatus>()

const Away = Schema.Struct({ game: GameId, since: Schema.DateTimeUtcFromString })
type Away = typeof Away.Type

/**
 * A Display's autopilot. While on, it promotes the best moment into the main tile and moves the sound with it, then
 * puts back what you chose (home) when the moment is over. Each command you send sets home and suspends the part it
 * touched for `suspension`. Pure.
 */
export class Autopilot extends Schema.Class<Autopilot>("sportal/Autopilot")({
  on: Schema.Boolean,
  /** What you chose: the main tile's game and the game whose sound is on. */
  home: Schema.Struct({
    main: Schema.OptionFromOptionalKey(GameId),
    audio: Schema.OptionFromOptionalKey(GameId)
  }),
  /** The game the autopilot moved each part to, and since when. */
  away: Schema.Struct({
    main: Schema.OptionFromOptionalKey(Away),
    audio: Schema.OptionFromOptionalKey(Away)
  }),
  /** Until when each part is yours. */
  suspended: Schema.Struct({
    main: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    audio: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  })
}) {
  static readonly off: Autopilot = new Autopilot({
    on: false,
    home: { main: Option.none(), audio: Option.none() },
    away: { main: Option.none(), audio: Option.none() },
    suspended: { main: Option.none(), audio: Option.none() }
  })

  /** How long an away game holds its part, unless it stops. */
  static readonly dwell = Duration.seconds(30)

  /** How long a command you send keeps the autopilot off the part it touched. */
  static readonly suspension = Duration.minutes(3)

  /** On, home taken from `screen`; or off, everything forgotten. The Screen is left as it is. */
  toggle(screen: Screen): Autopilot {
    return this.on ? Autopilot.off : new Autopilot({ ...Autopilot.off, on: true, home: homeOf(screen) })
  }

  /**
   * After `command`, which you sent, left the Screen as `after`: the parts it touches are yours for `suspension` and
   * no longer away. Home's main game is what `after` shows unless the main tile is still away; home's sound game is
   * what `after` shows when the command touched the sound or neither part is still away.
   */
  manual(command: ScreenCommand, after: Screen, now: DateTime.Utc): Autopilot {
    if (!this.on) return this
    const touched = suspends(command)
    const until = Option.some(DateTime.addDuration(now, Autopilot.suspension))
    const away = {
      main: touched.includes("main") ? Option.none() : this.away.main,
      audio: touched.includes("audio") ? Option.none() : this.away.audio
    }
    const shown = homeOf(after)
    return new Autopilot({
      on: true,
      home: {
        main: Option.isNone(away.main) ? shown.main : this.home.main,
        audio:
          touched.includes("audio") || (Option.isNone(away.main) && Option.isNone(away.audio))
            ? shown.audio
            : this.home.audio
      },
      away,
      suspended: {
        main: touched.includes("main") ? until : this.suspended.main,
        audio: touched.includes("audio") ? until : this.suspended.audio
      }
    })
  }

  /**
   * One step at `now` on `screen` with each game's classification: the next autopilot and the commands to send, in
   * order. The main tile is steered unless it is yours, else the sound unless it is yours. Off or soloed, nothing.
   */
  step(
    screen: Screen,
    classifications: SlateChanged["classifications"],
    now: DateTime.Utc
  ): readonly [Autopilot, ReadonlyArray<ScreenCommand>] {
    if (!this.on || Option.isSome(screen.solo)) return [this, []]
    const suspended = {
      main: Option.filter(this.suspended.main, (until) => DateTime.isLessThan(now, until)),
      audio: Option.filter(this.suspended.audio, (until) => DateTime.isLessThan(now, until))
    }
    const standing: Standing = {
      moment: (game) => classifications[game]?.moment,
      score: (game) => classifications[game]?.score ?? 0
    }

    if (Option.isNone(suspended.main)) {
      const [main, move] = follow(
        {
          tiles: occupiedIn(screen.tiles),
          home: this.home.main,
          current: Option.fromUndefinedOr(gameIn(screen.tiles[0])),
          away: this.away.main
        },
        standing,
        now
      )
      const commands = mainCommands(screen, this, move, Option.isSome(suspended.audio))
      return [new Autopilot({ ...this, suspended, away: { main, audio: Option.none() } }), commands]
    }

    if (Option.isNone(suspended.audio)) {
      const [audio, move] = follow(
        {
          tiles: occupiedIn(screen.onScreen()),
          home: this.home.audio,
          current: screen.audioFocus,
          away: this.away.audio
        },
        standing,
        now
      )
      const commands = Move.$match(move, {
        Stay: () => [],
        Home: () => soundTo(screen, this.home.audio),
        Go: ({ game }) => soundTo(screen, Option.some(game))
      })
      return [new Autopilot({ ...this, suspended, away: { main: Option.none(), audio } }), commands]
    }

    return [new Autopilot({ ...this, suspended, away: { main: Option.none(), audio: Option.none() } }), []]
  }

  /** When the next step may change something with no new slate: an away game's dwell ending, or a suspension. */
  nextDeadline(now: DateTime.Utc): Option.Option<DateTime.Utc> {
    const dwellEnd = (away: Option.Option<Away>) =>
      Option.toArray(Option.map(away, ({ since }) => DateTime.addDuration(since, Autopilot.dwell)))
    const times = [
      ...dwellEnd(this.away.main),
      ...dwellEnd(this.away.audio),
      ...Option.toArray(this.suspended.main),
      ...Option.toArray(this.suspended.audio)
    ]
    return Arr.head(times.filter((time) => DateTime.isGreaterThan(time, now)).toSorted(DateTime.Order))
  }

  /** What it is doing at `now`: the main tile before the sound, a part yours before a part away. */
  status(now: DateTime.Utc): AutopilotStatus {
    if (!this.on) return AutopilotStatus.Off()
    for (const part of ["main", "audio"] as const) {
      const until = Option.filter(this.suspended[part], (time) => DateTime.isLessThan(now, time))
      if (Option.isSome(until)) return AutopilotStatus.Yours({ part, until: until.value })
      const away = this.away[part]
      if (Option.isSome(away)) return AutopilotStatus.Away({ part, game: away.value.game })
    }
    return AutopilotStatus.Idle()
  }
}

/** Each game's moment and score, as the live classifications give them. */
interface Standing {
  readonly moment: (game: GameId) => Moment | undefined
  readonly score: (game: GameId) => number
}

/** One part, to steer: where it may go, home, where it is, and where the autopilot moved it. */
interface Steering {
  readonly tiles: ReadonlyArray<{ readonly tile: number; readonly game: GameId }>
  readonly home: Option.Option<GameId>
  readonly current: Option.Option<GameId>
  readonly away: Option.Option<Away>
}

/** Where one part goes: nowhere, back home, or to a game, handing off from another away game. */
type Move = Data.TaggedEnum<{
  Stay: object
  Home: object
  Go: { readonly game: GameId; readonly handOff: boolean }
}>
const Move = Data.taggedEnum<Move>()

/**
 * Where one part goes at `now`: the game it is then away on, if any, and the move that takes it there. An away game
 * holds through its dwell unless it stops, then until it is no longer wanted or a target comes strictly first.
 */
function follow(
  steering: Steering,
  standing: Standing,
  now: DateTime.Utc
): readonly [Option.Option<Away>, Move] {
  const { tiles, current } = steering
  const { moment } = standing
  const home = Option.getOrUndefined(steering.home)
  const homeOnTile = home !== undefined && tiles.some(({ game }) => game === home)
  const homeMoment = homeOnTile ? moment(home) : undefined
  const homeStopped = !homeOnTile || stopped(homeMoment)
  const homeAwayWorthy = !homeStopped && homeMoment !== undefined && awayWorthy(homeMoment)
  // While home is away-worthy it is the target: another game stays wanted until home's moment comes strictly first.
  const wanted = (game: GameId) => {
    const its = moment(game)
    if (its === undefined) return false
    if (homeStopped) return isLive(its)
    return homeAwayWorthy ? interest(its) <= interest(homeMoment) : awayWorthy(its)
  }
  const target = homeAwayWorthy
    ? undefined
    : Option.getOrUndefined(
        Arr.head(tiles.filter(({ game }) => game !== home && wanted(game)).toSorted(byInterest(standing)))
      )

  const away = Option.filter(steering.away, ({ game }) => Option.contains(current, game))
  if (Option.isSome(away)) {
    const { game, since } = away.value
    const its = moment(game)
    const dwelling = DateTime.isLessThan(now, DateTime.addDuration(since, Autopilot.dwell))
    if (!stopped(its) && dwelling) return [away, Move.Stay()]
    const outranked = target !== undefined && interest(moment(target.game)) < interest(its)
    if (wanted(game) && !outranked) return [away, Move.Stay()]
  }

  if (target === undefined) return [Option.none(), Option.isSome(away) ? Move.Home() : Move.Stay()]
  const going = Option.some({ game: target.game, since: now })
  if (Option.contains(current, target.game)) return [going, Move.Stay()]
  return [going, Move.Go({ game: target.game, handOff: Option.isSome(away) })]
}

/**
 * The commands for a move of the main tile. A hand-off promotes home first, so a later revert restores every tile; a
 * revert, a move while the sound is yours, or the end of a sound away puts the sound on home's sound game.
 */
function mainCommands(
  screen: Screen,
  { home, away }: Autopilot,
  move: Move,
  soundYours: boolean
): ReadonlyArray<ScreenCommand> {
  return Move.$match(move, {
    Stay: () => (Option.isSome(away.audio) ? soundTo(screen, home.audio) : []),
    Home: () => {
      const back = promoteTo(screen, home.main)
      return [...back, ...soundTo(afterAll(screen, back), home.audio)]
    },
    Go: ({ game, handOff }) => {
      const back = handOff ? promoteTo(screen, home.main) : []
      const moved = [...back, ...promoteTo(afterAll(screen, back), Option.some(game))]
      return soundYours ? [...moved, ...soundTo(afterAll(screen, moved), home.audio)] : moved
    }
  })
}

/** Most worth chasing first: a red zone, crunch time, a big play, plain live play. Anything else is not chased. */
const interestRank: { readonly [Tag in Moment["_tag"]]?: number } = {
  ScoringThreat: 0,
  CrunchTime: 1,
  BigPlay: 2,
  Live: 3
}

function interest(moment: Moment | undefined): number {
  return moment === undefined ? Infinity : (interestRank[moment._tag] ?? Infinity)
}

function isLive(moment: Moment): boolean {
  return interest(moment) < Infinity
}

function awayWorthy(moment: Moment): boolean {
  return moment._tag === "ScoringThreat" || moment._tag === "CrunchTime"
}

/** Whether a game has stopped: on a break or over. A game with no classification has not. */
function stopped(moment: Moment | undefined): boolean {
  return moment !== undefined && (moment._tag === "Break" || moment._tag === "Final")
}

/** The best first: the most worth chasing, then the higher score, then the lower tile. */
function byInterest(standing: Standing): Order.Order<{ readonly tile: number; readonly game: GameId }> {
  return Order.combine(
    Order.mapInput(Order.Number, ({ game }) => interest(standing.moment(game))),
    Order.combine(
      Order.mapInput(Order.Number, ({ game }) => -standing.score(game)),
      Order.mapInput(Order.Number, ({ tile }) => tile)
    )
  )
}

/** The parts a command you send makes yours. */
function suspends(command: ScreenCommand): ReadonlyArray<Part> {
  switch (command._tag) {
    case "Promote":
      return ["main"]
    case "Solo":
      return ["main", "audio"]
    case "Swap":
      return command.a === 0 || command.b === 0 ? ["main"] : []
    case "Assign":
    case "Clear":
      return command.tile === 0 ? ["main"] : []
    case "FocusAudio":
      return ["audio"]
    default:
      return []
  }
}

/** A `Promote` of the tile holding `game`, unless it is already the main tile or on no tile. */
function promoteTo(screen: Screen, game: Option.Option<GameId>): ReadonlyArray<ScreenCommand> {
  const tile = screen.tiles.findIndex((tile) => Option.exists(game, (wanted) => wanted === gameIn(tile)))
  return tile > 0 ? [{ _tag: "Promote", tile }] : []
}

/** `screen` after the autopilot's own commands; `Promote` and `FocusAudio` never ask a game's availability. */
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

/** A `FocusAudio` that puts the sound on `game`, unless it is already heard or not on screen. */
function soundTo(screen: Screen, game: Option.Option<GameId>): ReadonlyArray<ScreenCommand> {
  return Option.match(game, {
    onNone: () => [],
    onSome: (heard) => {
      const slot = screen.slotOf(heard)
      return screen.hears(heard) || slot === undefined ? [] : [{ _tag: "FocusAudio", tile: slot }]
    }
  })
}

function homeOf(screen: Screen): Autopilot["home"] {
  return { main: Option.fromUndefinedOr(gameIn(screen.tiles[0])), audio: screen.audioFocus }
}

function occupiedIn(tiles: ReadonlyArray<Tile>) {
  return tiles.flatMap((tile, index) => (Tile.guards.Empty(tile) ? [] : [{ tile: index, game: tile.game }]))
}

function gameIn(tile: Tile | undefined): GameId | undefined {
  return tile === undefined || Tile.guards.Empty(tile) ? undefined : tile.game
}
