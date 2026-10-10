import type { GameSnapshot } from "@sportal/domain/Game"
import { Play, type PlayId } from "@sportal/domain/Play"
import { Data, Option } from "effect"

/**
 * Which plays a field has drawn: settled on the situation after the play with sequence `last`, or animating `play`
 * with `queued` to follow. `last` is the newest play taken in, drawn, queued, or dropped from a full queue.
 */
export type FieldDrawing = Data.TaggedEnum<{
  Settled: { readonly last: number }
  Animating: { readonly play: Play; readonly queued: ReadonlyArray<Play>; readonly last: number }
}>
const drawings = Data.taggedEnum<FieldDrawing>()
export const FieldDrawing = {
  Settled: drawings.Settled,
  Animating: drawings.Animating,
  $is: drawings.$is,
  $match: drawings.$match,
  initial,
  step,
  spotsOf
}

/** What a field hears: plays arrived from the Hub, or a play finished drawing. */
export type FieldEvent = Data.TaggedEnum<{
  Arrived: { readonly plays: ReadonlyArray<Play>; readonly game: GameSnapshot }
  Drawn: { readonly play: PlayId; readonly game: GameSnapshot }
}>
export const FieldEvent = Data.taggedEnum<FieldEvent>()

/** A field's first drawing: the plays on hand are taken as drawn. */
function initial(plays: ReadonlyArray<Play>): FieldDrawing {
  return FieldDrawing.Settled({ last: newestOf(plays) })
}

/**
 * What a drawing becomes on an event. Each new play is drawn in turn, only the newest few when many arrive at once;
 * all are taken as drawn again when the plays go back to an earlier sequence (the feed started over).
 */
function step(drawing: FieldDrawing, event: FieldEvent): FieldDrawing {
  return FieldEvent.$match(event, {
    Arrived: ({ plays, game }) => {
      const newestSent = newestOf(plays)
      if (newestSent < drawing.last) return FieldDrawing.Settled({ last: newestSent })
      const fresh = plays.filter((play) => play.sequence > drawing.last).toSorted(Play.order)
      const newest = fresh.at(-1)
      if (newest === undefined) return drawing
      return FieldDrawing.$match(drawing, {
        Settled: () => nextOf(fresh.slice(-queueLength), newest.sequence, game),
        Animating: (current) =>
          FieldDrawing.Animating({
            ...current,
            queued: [...current.queued, ...fresh].slice(-queueLength),
            last: newest.sequence
          })
      })
    },
    Drawn: (drawn) =>
      FieldDrawing.$match(drawing, {
        Settled: () => drawing,
        Animating: ({ play, queued, last }) =>
          play.id === drawn.play ? nextOf(queued, last, drawn.game) : drawing
      })
  })
}

/** Where a play started and ended on the field, when both are on it. */
function spotsOf(game: GameSnapshot, play: Play) {
  return Option.all({ start: game.spotOf(play.start), end: game.spotOf(play.end) })
}

function newestOf(plays: ReadonlyArray<Play>): number {
  return Math.max(-1, ...plays.map((play) => play.sequence))
}

/** The first play in `queue` with both spots on the field, drawing; the plays before it are skipped. */
function nextOf(queue: ReadonlyArray<Play>, last: number, game: GameSnapshot): FieldDrawing {
  const index = queue.findIndex((play) => Option.isSome(spotsOf(game, play)))
  const play = queue[index]
  return play === undefined
    ? FieldDrawing.Settled({ last })
    : FieldDrawing.Animating({ play, queued: queue.slice(index + 1), last })
}

/**
 * The most plays a field waits to draw: a page that was hidden while plays arrived draws only the newest few, not the
 * whole backlog.
 */
const queueLength = 3
