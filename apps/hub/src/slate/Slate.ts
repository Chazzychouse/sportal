import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import type { RecentPlays } from "@sportal/domain/RecentPlays"
import { Data, Equal } from "effect"
import { Delivery } from "./Delivery.ts"

/**
 * The slate: the games each league's last listing names, in its order, each as the latest snapshot not behind the one
 * before it, and each game's plays. Pure: `take` returns the next slate.
 */
export class Slate extends Data.Class<{
  /** Each league's listed games, in listed order. */
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameId>>
  /** Each listed game, as the slate has it. */
  readonly games: ReadonlyMap<GameId, GameSnapshot>
  /** Each listed game's plays, in `Play.order`; a game with none is absent. */
  readonly plays: ReadonlyMap<GameId, ReadonlyArray<Play>>
}> {
  static readonly empty: Slate = new Slate({ listed: new Map(), games: new Map(), plays: new Map() })

  /** How many of a game's plays `recentPlays` keeps: its last ten. */
  private static readonly recentPlayCount = 10

  /**
   * Takes one frame's deliveries, in order. A listing takes each of its games as a snapshot, the push winning a tie
   * (`relisted`), then forgets the league's games it no longer names. A snapshot of a listed game is taken unless it is behind the game (`isBehind`), though an
   * over game takes one ahead of its end (overtime after a spurious final, or a postponed game resuming); a snapshot or
   * plays of a game no listing names are dropped. Plays replace a listed game's plays. A take that changes nothing gives
   * back this slate itself.
   */
  take(deliveries: ReadonlyArray<Delivery>): Slate {
    return deliveries.reduce<Slate>((slate, delivery) => slate.delivered(delivery), this)
  }

  /** Each listed game in `leagues`, leagues in order, as the slate has it. */
  listedGames(leagues: ReadonlyArray<LeagueId>): ReadonlyArray<GameSnapshot> {
    return leagues.flatMap((league) =>
      (this.listed.get(league) ?? []).flatMap((id) => {
        const game = this.games.get(id)
        return game === undefined ? [] : [game]
      })
    )
  }

  /** The last `recentPlayCount` plays of each of `games` that has plays. */
  recentPlays(games: ReadonlyArray<GameSnapshot>): RecentPlays {
    return Object.fromEntries(
      games.flatMap(({ id }) => {
        const plays = this.plays.get(id) ?? []
        return plays.length === 0 ? [] : [[id, plays.slice(-Slate.recentPlayCount)] as const]
      })
    )
  }

  /** What the live stream sends of it: every league's listed games, as the slate has them, and their recent plays. */
  published(): SlateChanged {
    const games = this.listedGames(LeagueId.literals)
    const recentPlays = this.recentPlays(games)
    return LiveMessage.cases.SlateChanged.make({ games, recentPlays })
  }

  private delivered(delivery: Delivery): Slate {
    return Delivery.match(delivery, {
      Listing: ({ league, games }) => this.relisted(league, games),
      Snapshot: ({ snapshot }) => (this.games.has(snapshot.id) ? this.snapshotTaken(snapshot) : this),
      Plays: ({ game, plays }) => (this.games.has(game) ? this.playsTaken(game, plays) : this)
    })
  }

  /**
   * League `league` listing `games`: each taken, then the league's games it no longer names forgotten. A listing is a
   * poll, and the push wins a tie: a live game keeps its snapshot over a listed one at the same game time not ahead of
   * it, which a poll lagging the push between plays would be.
   */
  private relisted(league: LeagueId, games: ReadonlyArray<GameSnapshot>): Slate {
    const taken = games.reduce<Slate>(
      (slate, snapshot) => (slate.tiedLive(snapshot) ? slate : slate.snapshotTaken(snapshot)),
      this
    )
    const ids = games.map(({ id }) => id)
    const had = this.listed.get(league) ?? []
    if (Equal.equals(had, ids)) return taken

    const dropped = new Set(had.filter((id) => !ids.includes(id)))
    return new Slate({
      listed: new Map(taken.listed).set(league, ids),
      games: without(taken.games, dropped),
      plays: without(taken.plays, dropped)
    })
  }

  /** `snapshot` taken: the game's first, or one not behind it. */
  private snapshotTaken(snapshot: GameSnapshot): Slate {
    const had = this.games.get(snapshot.id)
    if (had !== undefined && (Equal.equals(had, snapshot) || isBehind(snapshot, had))) return this

    return new Slate({ ...this, games: new Map(this.games).set(snapshot.id, snapshot) })
  }

  /** Whether the slate's game of `snapshot` is live at the same game time, and `snapshot` is not ahead of it. */
  private tiedLive(snapshot: GameSnapshot): boolean {
    const had = this.games.get(snapshot.id)
    return (
      had !== undefined &&
      had.progress() === "live" &&
      GameSnapshot.gameTime(snapshot, had) === 0 &&
      !snapshot.isAheadOf(had)
    )
  }

  /** Game `id`'s whole list of plays, replaced, in `Play.order`. */
  private playsTaken(id: GameId, plays: ReadonlyArray<Play>): Slate {
    const sorted = plays.toSorted(Play.order)
    if (Equal.equals(sorted, this.plays.get(id) ?? [])) return this

    return new Slate({ ...this, plays: new Map(this.plays).set(id, sorted) })
  }
}

/**
 * Behind `had`: earlier in game time, or at the same game time with fewer points (a poll lagging a pushed score),
 * unless `had` is over and `snapshot` is ahead of its end.
 */
function isBehind(snapshot: GameSnapshot, had: GameSnapshot): boolean {
  const resumed = had.progress() === "over" && snapshot.isAheadOfOver(had)
  return had.isAheadOf(snapshot) && !snapshot.isAheadOf(had) && !resumed
}

function without<A>(map: ReadonlyMap<GameId, A>, ids: ReadonlySet<GameId>): ReadonlyMap<GameId, A> {
  return ids.size === 0 ? map : new Map([...map].filter(([id]) => !ids.has(id)))
}
