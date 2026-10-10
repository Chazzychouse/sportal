import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { Array as Arr, Data, DateTime, Duration, Option, Order, Schema } from "effect"
import { Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/** The two things the autopilot steers: the main tile and the sound. */
export type Part = "main" | "audio"

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
   * no longer away, and home is what `after` shows for each part not away.
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
        audio: Option.isNone(away.main) && Option.isNone(away.audio) ? shown.audio : this.home.audio
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
    const soundBack = (promoted: number | undefined) => audioReturn(screen, this.home.audio, promoted)

    if (Option.isNone(suspended.main)) {
      const homeGame = Option.getOrUndefined(this.home.main)
      const homeTile = screen.tiles.findIndex((tile) => homeGame !== undefined && gameIn(tile) === homeGame)
      const back: ReadonlyArray<ScreenCommand> =
        homeTile === -1 ? [] : [{ _tag: "Promote", tile: homeTile }, ...soundBack(homeTile)]
      const [main, commands] = follow(
        {
          tiles: occupiedIn(screen.tiles),
          home: this.home.main,
          current: Option.fromUndefinedOr(gameIn(screen.tiles[0])),
          away: this.away.main,
          go: (tile) => [
            { _tag: "Promote", tile },
            ...(Option.isSome(suspended.audio) ? soundBack(tile) : [])
          ],
          back
        },
        standing,
        now
      )
      const sent = commands.length === 0 && Option.isSome(this.away.audio) ? soundBack(undefined) : commands
      return [new Autopilot({ ...this, suspended, away: { main, audio: Option.none() } }), sent]
    }

    if (Option.isNone(suspended.audio)) {
      const [audio, commands] = follow(
        {
          tiles: occupiedIn(screen.onScreen()),
          home: this.home.audio,
          current: screen.audioFocus,
          away: this.away.audio,
          go: (tile) => [{ _tag: "FocusAudio", tile }],
          back: soundBack(undefined)
        },
        standing,
        now
      )
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

/** One part, to steer: where it may go, home, where it is, where the autopilot moved it, and how to move it. */
interface Steering {
  readonly tiles: ReadonlyArray<{ readonly tile: number; readonly game: GameId }>
  readonly home: Option.Option<GameId>
  readonly current: Option.Option<GameId>
  readonly away: Option.Option<Away>
  readonly go: (tile: number) => ReadonlyArray<ScreenCommand>
  readonly back: ReadonlyArray<ScreenCommand>
}

/**
 * Where one part goes at `now`: the game it is then away on, if any, and the commands that take it there. An away
 * game holds through its dwell unless it stops, then until it is no longer wanted or a target comes strictly first.
 */
function follow(
  steering: Steering,
  standing: Standing,
  now: DateTime.Utc
): readonly [Option.Option<Away>, ReadonlyArray<ScreenCommand>] {
  const { tiles, current, go, back } = steering
  const { moment } = standing
  const home = Option.getOrUndefined(steering.home)
  const homeOnTile = home !== undefined && tiles.some(({ game }) => game === home)
  const homeMoment = homeOnTile ? moment(home) : undefined
  // A home game with no classification yet counts as live: only a break, a final or no tile is stopped.
  const homeStopped = !homeOnTile || (homeMoment !== undefined && stopped(homeMoment))
  const wanted = (game: GameId) => {
    const its = moment(game)
    return its !== undefined && (homeStopped ? interest(its) < Infinity : awayWorthy(its))
  }
  const homeHolds = !homeStopped && homeMoment !== undefined && awayWorthy(homeMoment)
  const target = homeHolds
    ? undefined
    : Option.getOrUndefined(
        Arr.head(tiles.filter(({ game }) => game !== home && wanted(game)).toSorted(byInterest(standing)))
      )

  const away = Option.filter(steering.away, ({ game }) => Option.contains(current, game))
  if (Option.isSome(away)) {
    const { game, since } = away.value
    const its = moment(game)
    const dwelling = DateTime.isLessThan(now, DateTime.addDuration(since, Autopilot.dwell))
    if (!stopped(its) && dwelling) return [away, []]
    const outranked = target !== undefined && interest(moment(target.game)) < interest(its)
    if (!stopped(its) && wanted(game) && !outranked) return [away, []]
  }

  if (target === undefined) return [Option.none(), Option.isSome(away) ? back : []]
  const going = Option.some({ game: target.game, since: now })
  return [going, Option.contains(current, target.game) ? [] : go(target.tile)]
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

function awayWorthy(moment: Moment): boolean {
  return moment._tag === "ScoringThreat" || moment._tag === "CrunchTime"
}

/** Whether a game has stopped: on a break, over, or with no classification to say. */
function stopped(moment: Moment | undefined): boolean {
  return moment === undefined || moment._tag === "Break" || moment._tag === "Final"
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

/**
 * The command that puts the sound back on `homeAudio` once the tile `promoted` is promoted (undefined: no promote).
 * None when the sound would already be on it, or it would not be on screen.
 */
function audioReturn(
  screen: Screen,
  homeAudio: Option.Option<GameId>,
  promoted: number | undefined
): ReadonlyArray<ScreenCommand> {
  const audio = Option.getOrUndefined(homeAudio)
  const heard =
    promoted === undefined ? Option.getOrUndefined(screen.audioFocus) : gameIn(screen.tiles[promoted])
  if (audio === undefined || audio === heard) return []
  const index = screen.tiles.findIndex((tile) => gameIn(tile) === audio)
  const slot =
    promoted === undefined || index === -1 ? index : index === 0 ? promoted : index === promoted ? 0 : index
  return slot === -1 || slot >= Screen.slotCount(screen.layout) ? [] : [{ _tag: "FocusAudio", tile: slot }]
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
