import type { GameList } from "@sportal/api/GamesQuery"
import type { ListedGame } from "@sportal/api/ListedGame"
import { type GameId, PlaysChange } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Option } from "effect"
import { Atom } from "effect/reactivity"
import * as LiveStream from "./LiveStream.ts"

/**
 * Today's games in every league, live: none before the first answer. What the Screen, the palette and the Remote
 * read; kept open for the page's life.
 */
export const today = LiveStream.of(
  (client) => client.listLive({}),
  Option.none<GameList>(),
  (_, answer) => Option.some(answer)
).pipe(Atom.keepAlive)

/** Game `id` with its availability, live: none before the first answer. Asked of the Hub only while read. */
export const game = Atom.family((id: GameId) =>
  LiveStream.of(
    (client) => client.gameLive({ id }),
    Option.none<ListedGame>(),
    (_, answer) => Option.some(answer)
  )
)

/**
 * Game `id`'s latest plays, newest first, live: a reset replaces them and an append goes before them. Asked of the
 * Hub only while read.
 */
export const plays = Atom.family((id: GameId) =>
  LiveStream.of(
    (client) => client.playsLive({ id }),
    noPlays,
    (had, change) =>
      PlaysChange.match(change, {
        Reset: ({ plays }) => plays,
        Appended: ({ plays }) => [...plays, ...had]
      })
  )
)

const noPlays: ReadonlyArray<Play> = []
