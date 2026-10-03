import { GameSnapshot } from "@sportal/domain/Game"
import { localTime } from "../LocalTime.ts"

export function SlateView(props: {
  slate: ReadonlyArray<GameSnapshot>
  connected: boolean
  onPick: (game: GameSnapshot) => void
}) {
  return (
    <aside className="flex min-h-0 flex-col border-neutral-800 border-r">
      <header className="flex items-baseline justify-between px-3 py-2">
        <h1 className="font-semibold text-lg">Slate</h1>
        {window.sportalShell && (
          <button
            type="button"
            onClick={() => window.sportalShell?.openSignIn()}
            className="text-neutral-400 text-xs hover:text-neutral-100"
          >
            Sign in to YouTube TV
          </button>
        )}
        <span className={props.connected ? "text-emerald-400 text-xs" : "text-amber-400 text-xs"}>
          {props.connected ? "live" : "reconnecting…"}
        </span>
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {[...props.slate].sort(GameSnapshot.watchOrder).map((game) => (
          <li key={game.id}>
            <button
              type="button"
              onClick={() => props.onPick(game)}
              className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-2 text-left hover:bg-neutral-900"
            >
              <SideLine side={game.away} />
              <span className="row-span-2 self-center text-right text-neutral-400 text-xs">
                <span className={game.isLive() ? "block text-emerald-400" : "block"}>{statusText(game)}</span>
                {game.broadcasts.map(({ network }) => network).join(" · ")}
              </span>
              <SideLine side={game.home} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function SideLine(props: { side: GameSnapshot["home"] }) {
  return (
    <span className="flex justify-between tabular-nums">
      <span>
        {props.side.ranking !== undefined && (
          <span className="mr-1 text-neutral-500 text-xs">{props.side.ranking}</span>
        )}
        {props.side.team.abbreviation}
      </span>
      <span>{props.side.score}</span>
    </span>
  )
}

function statusText(game: GameSnapshot): string {
  switch (game.status) {
    case "live":
      return `Q${game.period} ${game.clock}`
    case "scheduled":
      return localTime(game.kickoff)
    default:
      return game.status
  }
}
