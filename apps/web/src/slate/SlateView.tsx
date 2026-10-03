import { GameSnapshot } from "@sportal/domain/Game"
import { statusText } from "./StatusText.ts"

export function SlateView(props: {
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  onPick: (game: GameSnapshot) => void
}) {
  const live = props.slate.filter((game) => game.isLive()).length
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between px-3 pt-2.5 pb-1.5">
        <h1 className="label-caps text-[11px] text-muted-foreground">
          Slate <span className="font-mono">{props.slate.length}</span>
          {live > 0 && <span className="ml-2 text-live">{live} live</span>}
        </h1>
        <span className="label-caps text-[11px] text-muted-foreground">
          to tile <span className="font-mono text-foreground">{props.selected + 1}</span>
        </span>
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {[...props.slate].sort(GameSnapshot.watchOrder).map((game) => (
          <li key={game.id} className="border-border/60 border-b last:border-b-0">
            <button
              type="button"
              onClick={() => props.onPick(game)}
              className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <SideLine side={game.away} />
              <span className="row-span-2 self-center text-right">
                <span
                  className={`label-caps block text-[11px] ${game.isLive() ? "text-live" : "text-muted-foreground"}`}
                >
                  {statusText(game)}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {game.broadcasts.map(({ network }) => network).join(" · ")}
                </span>
              </span>
              <SideLine side={game.home} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SideLine(props: { side: GameSnapshot["home"] }) {
  return (
    <span className="flex justify-between font-mono text-[13px]">
      <span>
        {props.side.ranking !== undefined && (
          <span className="mr-1 text-[10px] text-muted-foreground">{props.side.ranking}</span>
        )}
        <span className="font-semibold">{props.side.team.abbreviation}</span>
      </span>
      <span>{props.side.score}</span>
    </span>
  )
}
