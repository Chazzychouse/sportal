import type { GameSnapshot } from "@sportal/domain/Game"
import { Layout } from "@sportal/domain/Layout"
import type { Stage } from "@sportal/domain/Stage"
import { dispatch } from "../hub/HubClient.ts"
import { statusText } from "../slate/StatusText.ts"
import { tileDrag } from "./TileChrome.tsx"

/** The games the layout has no slot for. Clicking one swaps it into the selected tile; any can be dragged onto a tile. */
export function Bench(props: { stage: Stage; slate: ReadonlyArray<GameSnapshot>; selected: number }) {
  const first = Layout.slotCount(props.stage.layout)
  const benched = props.stage.tiles.flatMap((tile, index) =>
    index < first || tile._tag === "Empty"
      ? []
      : [{ index, game: props.slate.find((g) => g.id === tile.game) }]
  )
  if (benched.length === 0) return null
  return (
    <section className="border-t">
      <h2 className="label-caps px-3 pt-2.5 pb-1 text-[11px] text-muted-foreground">
        Bench <span className="font-mono">{benched.length}</span>
      </h2>
      <ul className="pb-1.5">
        {benched.map(({ index, game }) => (
          <li key={index}>
            <button
              type="button"
              draggable
              onDragStart={(event) => event.dataTransfer.setData(tileDrag, String(index))}
              onClick={() => dispatch({ _tag: "Swap", a: index, b: props.selected })}
              className="flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-accent"
              title={`Swap into tile ${props.selected + 1}`}
            >
              <span className="size-1.5 rounded-full bg-muted-foreground/50" />
              {game === undefined ? (
                <span className="text-muted-foreground">Off the slate</span>
              ) : (
                <>
                  <span>
                    {game.away.team.abbreviation} {game.away.score}–{game.home.score}{" "}
                    {game.home.team.abbreviation}
                  </span>
                  <span
                    className={`label-caps ml-auto text-[10px] ${game.isLive() ? "text-live" : "text-muted-foreground"}`}
                  >
                    {statusText(game)}
                  </span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
