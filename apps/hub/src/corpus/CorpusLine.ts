import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play, PlayId } from "@sportal/domain/Play"
import { Array as Arr, Data, DateTime, Effect, Equal, Order, Schema, Stream } from "effect"
import type { Decoded } from "../provider/Decoder.ts"

/**
 * One line of a corpus day's poll or push file: a listing changed or unchanged since its league's last, a pushed
 * snapshot, or the plays a game added, changed, and removed since its last.
 */
export const CorpusInput = Schema.TaggedUnion({
  ListingChanged: { league: LeagueId, games: Schema.Array(GameSnapshot) },
  ListingUnchanged: { league: LeagueId },
  Snapshot: { snapshot: GameSnapshot },
  PlaysChanged: { game: GameId, upserts: Schema.Array(Play), removed: Schema.Array(PlayId) }
})
export type CorpusInput = typeof CorpusInput.Type

/** A corpus input as a day stores it: the frame's seq, its arrival instant, and the input. */
export class CorpusLine extends Schema.Class<CorpusLine>("sportal/hub/CorpusLine")({
  seq: Schema.Int,
  at: Schema.DateTimeUtcFromMillis,
  input: CorpusInput
}) {
  /** This corpus format; a day built to another does not load. */
  static readonly format: number = 2

  /** A corpus day's order: by arrival, then by `seq`, so a frame's lines sit together and `Had` threads one way. */
  static readonly byArrival: Order.Order<{ readonly at: DateTime.Utc; readonly seq: number }> = Order.Struct({
    at: DateTime.Order,
    seq: Order.Number
  })

  /**
   * A day's lines from its frames, in the day's order (`byArrival`): each frame's against what the day had before it
   * (each league's last listing, each game's last plays), the inverse of `decodedOf`. Listings go to the poll file,
   * pushed snapshots and plays to the push file. A snapshot from the poll is a defect: ESPN's decode never says one.
   */
  static ofDecoded(decoded: Stream.Stream<Decoded>): Effect.Effect<{
    readonly poll: ReadonlyArray<CorpusLine>
    readonly push: ReadonlyArray<CorpusLine>
  }> {
    return decoded.pipe(
      Stream.mapAccumEffect(
        () => Had.empty,
        (had, frame) => Effect.map(CorpusLine.of(frame, had), (lines) => [lines.had, [lines]] as const)
      ),
      Stream.runCollect,
      Effect.map((frames) => ({
        poll: frames.flatMap(({ poll }) => poll),
        push: frames.flatMap(({ push }) => push)
      }))
    )
  }

  /** The deliveries a day's `lines`, from both its files, say: one step per frame, in the day's order. */
  static decodedOf(
    lines: ReadonlyArray<CorpusLine>
  ): Stream.Stream<Pick<Decoded, "seq" | "at" | "deliveries">> {
    return Stream.fromIterable(lines.toSorted(CorpusLine.byArrival)).pipe(
      Stream.groupAdjacentBy((line) => line.seq),
      Stream.mapAccum(
        () => Had.empty,
        (had, [seq, frame]): readonly [Had, ReadonlyArray<Pick<Decoded, "seq" | "at" | "deliveries">>] => {
          const read = CorpusLine.deliveries(frame, had)
          return [read.had, [{ seq, at: Arr.headNonEmpty(frame).at, deliveries: read.deliveries }]]
        }
      )
    )
  }

  /** One frame's lines from what it delivered, against what the day had before it; with what the day has after. */
  private static of(
    decoded: Decoded,
    had: Had
  ): Effect.Effect<{
    readonly poll: ReadonlyArray<CorpusLine>
    readonly push: ReadonlyArray<CorpusLine>
    readonly had: Had
  }> {
    return Effect.reduce(
      decoded.deliveries,
      () => ({ poll: Arr.empty<CorpusLine>(), push: Arr.empty<CorpusLine>(), had }),
      (lines, delivery) =>
        Delivery.match<Effect.Effect<readonly ["poll" | "push", CorpusInput]>>(delivery, {
          Listing: ({ league, games }) =>
            Effect.succeed([
              "poll",
              Equal.equals(lines.had.listings.get(league), games)
                ? CorpusInput.cases.ListingUnchanged.make({ league })
                : CorpusInput.cases.ListingChanged.make({ league, games })
            ]),
          Snapshot: ({ snapshot, from }) =>
            from === "push"
              ? Effect.succeed(["push", CorpusInput.cases.Snapshot.make({ snapshot })])
              : Effect.die(
                  new Error(
                    `Frame ${decoded.seq} delivered a poll snapshot of game ${snapshot.id}; a corpus day has no place for one`
                  )
                ),
          Plays: ({ game, plays }) => Effect.succeed(["push", lines.had.changes(game, plays)])
        }).pipe(
          Effect.map(([file, input]) => {
            const line = new CorpusLine({ seq: decoded.seq, at: decoded.at, input })
            return {
              poll: file === "poll" ? [...lines.poll, line] : lines.poll,
              push: file === "push" ? [...lines.push, line] : lines.push,
              had: lines.had.delivered(delivery)
            }
          })
        )
    )
  }

  /** The deliveries `lines` (one frame's, from both files) say, against `had`; with the next `had`. */
  private static deliveries(
    lines: ReadonlyArray<CorpusLine>,
    had: Had
  ): { readonly deliveries: ReadonlyArray<Delivery>; readonly had: Had } {
    return lines.reduce(
      (read, { input }) => {
        const delivery = CorpusInput.match<Delivery>(input, {
          ListingChanged: ({ league, games }) => Delivery.cases.Listing.make({ league, games }),
          ListingUnchanged: ({ league }) =>
            Delivery.cases.Listing.make({ league, games: read.had.listings.get(league) ?? [] }),
          Snapshot: ({ snapshot }) => Delivery.cases.Snapshot.make({ snapshot, from: "push" }),
          PlaysChanged: ({ game, upserts, removed }) =>
            Delivery.cases.Plays.make({ game, plays: read.had.changed(game, upserts, removed) })
        })
        return { deliveries: [...read.deliveries, delivery], had: read.had.delivered(delivery) }
      },
      { deliveries: Arr.empty<Delivery>(), had }
    )
  }
}

/** What a day had delivered so far: each league's last listing and each game's last plays. */
class Had extends Data.Class<{
  readonly listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly plays: ReadonlyMap<GameId, ReadonlyArray<Play>>
}> {
  /** A day before its first frame. */
  static readonly empty: Had = new Had({ listings: new Map(), plays: new Map() })

  /** What the day has once `delivery` is delivered: a listing is its league's last, and plays their game's. */
  delivered(delivery: Delivery): Had {
    return Delivery.match<Had>(delivery, {
      Listing: ({ league, games }) =>
        new Had({ listings: new Map([...this.listings, [league, games]]), plays: this.plays }),
      Snapshot: () => this,
      Plays: ({ game, plays }) =>
        new Had({ listings: this.listings, plays: new Map([...this.plays, [game, plays]]) })
    })
  }

  /** `game`'s plays becoming `plays`, as the plays added or changed since its last, and the ids gone from them. */
  changes(game: GameId, plays: ReadonlyArray<Play>): CorpusInput {
    const before = new Map((this.plays.get(game) ?? []).map((play) => [play.id, play]))
    const kept = new Set(plays.map(({ id }) => id))
    return CorpusInput.cases.PlaysChanged.make({
      game,
      upserts: plays.filter((play) => !Equal.equals(before.get(play.id), play)),
      removed: [...before.keys()].filter((id) => !kept.has(id))
    })
  }

  /** `game`'s whole list once `upserts` are added or changed and `removed` dropped, in `Play.order`. */
  changed(game: GameId, upserts: ReadonlyArray<Play>, removed: ReadonlyArray<PlayId>): ReadonlyArray<Play> {
    const replaced = new Set([...removed, ...upserts.map(({ id }) => id)])
    return [...(this.plays.get(game) ?? []).filter(({ id }) => !replaced.has(id)), ...upserts].toSorted(
      Play.order
    )
  }
}
