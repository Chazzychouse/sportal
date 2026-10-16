import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameStats, type Leader, type TeamStat, type WinChance } from "@sportal/domain/GameStats"
import type { Highlight } from "@sportal/domain/Highlight"
import { League } from "@sportal/domain/League"
import type { PlayId } from "@sportal/domain/Play"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/design/ClassName"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { standing, trails } from "../game/Score.tsx"
import { teamColor, teamEdge, teamHalf } from "../game/TeamColors.ts"
import { TeamLogo } from "../game/TeamLogo.tsx"
import * as Games from "../hub/Games.ts"
import * as Stats from "../hub/Stats.ts"
import { type ThemeName, useTheme } from "../ui/Theme.ts"
import { HighlightCard } from "./HighlightCard.tsx"
import * as StatsFit from "./StatsFit.ts"

/**
 * A game's stats, as a broadcast stat page: its header from the snapshot, then linescore, team stats, leaders, win
 * probability, scoring summary and highlights, each when the stats have it. On a page every section shows and the
 * page scrolls; in a tile, as many as fit, in that order, and never a scrollbar. A live game's stats follow the Hub;
 * any other game's are asked once.
 */
export function GameStatsView(props: { game: GameId; fit: Fit }) {
  const { value } = useAtomValue(Games.game(props.game))
  return Option.match(value, {
    onNone: () => <p className="m-auto text-muted-foreground text-sm">Loading…</p>,
    onSome: ({ snapshot }) =>
      snapshot.progress() === "live" ? (
        <LiveStats game={snapshot} fit={props.fit} />
      ) : (
        <AskedStats game={snapshot} fit={props.fit} />
      )
  })
}

/** Where the stats show: a page, every section and scrolling, or a tile, the sections that fit. */
type Fit = "page" | "tile"

function LiveStats(props: { game: GameSnapshot; fit: Fit }) {
  const { value } = useAtomValue(Stats.statsLive(props.game.id))
  return (
    <StatsSections
      game={props.game}
      fit={props.fit}
      stats={Option.getOrUndefined(value)}
      unavailable={false}
    />
  )
}

function AskedStats(props: { game: GameSnapshot; fit: Fit }) {
  const result = useAtomValue(Stats.stats(props.game.id))
  return (
    <StatsSections
      game={props.game}
      fit={props.fit}
      stats={AsyncResult.isSuccess(result) ? result.value : undefined}
      unavailable={AsyncResult.isFailure(result)}
    />
  )
}

interface SectionsProps {
  game: GameSnapshot
  fit: Fit
  stats: GameStats | undefined
  unavailable: boolean
}

function StatsSections(props: SectionsProps) {
  const theme = useTheme()
  const sections = sectionsOf(props, theme)
  if (props.fit === "tile") return <Fitted sections={sections} />
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 pt-4 pb-10">
      {sections.map(({ section, node }) => (
        <section key={section}>{node}</section>
      ))}
    </div>
  )
}

/** Each section the stats have, in priority order; before the stats, the header and why there are none yet. */
function sectionsOf(
  { game, fit, stats, unavailable }: SectionsProps,
  theme: ThemeName
): ReadonlyArray<{ section: string; node: ReactNode }> {
  const header = { section: "header", node: <Header game={game} fit={fit} theme={theme} /> }
  if (stats === undefined) {
    const text = unavailable ? "Stats unavailable" : "Loading stats…"
    return [header, { section: "status", node: <p className="text-muted-foreground text-sm">{text}</p> }]
  }
  const { linescore, teamStats, leaders, winProbability, scoringPlays, highlights } = stats
  return [
    header,
    ...(linescore.home.length + linescore.away.length > 0
      ? [
          {
            section: "linescore",
            node: (
              <Panel title="Linescore">
                <Linescore game={game} stats={stats} />
              </Panel>
            )
          }
        ]
      : []),
    ...(teamStats.length > 0
      ? [
          {
            section: "teamStats",
            node: (
              <Panel title="Team stats">
                <TeamStats game={game} rows={teamStats} theme={theme} />
              </Panel>
            )
          }
        ]
      : []),
    ...(leaders.length > 0
      ? [
          {
            section: "leaders",
            node: (
              <Panel title="Leaders">
                <Leaders leaders={leaders} />
              </Panel>
            )
          }
        ]
      : []),
    ...(winProbability !== undefined && winProbability.length > 1
      ? [
          {
            section: "winProbability",
            node: (
              <Panel title="Win probability">
                <WinProbability game={game} chances={winProbability} theme={theme} />
              </Panel>
            )
          }
        ]
      : []),
    ...(scoringPlays.length > 0
      ? [
          {
            section: "scoring",
            node: (
              <Panel title="Scoring">
                <Scoring game={game} ids={scoringPlays} />
              </Panel>
            )
          }
        ]
      : []),
    ...(highlights.length > 0
      ? [
          {
            section: "highlights",
            node: (
              <Panel title="Highlights">
                <Highlights highlights={highlights} />
              </Panel>
            )
          }
        ]
      : [])
  ]
}

/**
 * The sections that fit the tile's height, measured from an invisible copy of all of them at the same width, again
 * whenever the tile or what they hold changes size.
 */
function Fitted(props: { sections: ReadonlyArray<{ section: string; node: ReactNode }> }) {
  const box = useRef<HTMLDivElement>(null)
  const measured = useRef<HTMLDivElement>(null)
  const names = props.sections.map(({ section }) => section)
  const [shown, setShown] = useState<ReadonlyArray<string>>(names.slice(0, 1))
  const key = names.join(" ")

  useLayoutEffect(() => {
    const outer = box.current
    const inner = measured.current
    if (outer === null || inner === null) return undefined
    const fit = () => {
      const sections = key.split(" ")
      const heights = [...inner.children].map((child, index) => ({
        section: sections[index] ?? "",
        height: child.getBoundingClientRect().height
      }))
      const next = StatsFit.sectionsThatFit(outer.clientHeight, heights)
      setShown((last) => (last.join(" ") === next.join(" ") ? last : next))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [key])

  return (
    <div ref={box} className="relative size-full self-stretch overflow-hidden">
      <div ref={measured} aria-hidden inert className="invisible absolute inset-x-0 top-0">
        {props.sections.map(({ section, node }) => (
          <div key={section} className="px-3 pt-3">
            {node}
          </div>
        ))}
      </div>
      {props.sections
        .filter(({ section }) => shown.includes(section))
        .map(({ section, node }) => (
          <div key={section} className="px-3 pt-3">
            {node}
          </div>
        ))}
    </div>
  )
}

/** A section's frame: the theme's card surface, its name as a lower-third label. */
function Panel(props: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-card-edge px-4 py-3 backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]">
      <h3 className="label-caps mb-2.5 text-[11px] text-muted-foreground tracking-[0.14em]">{props.title}</h3>
      {props.children}
    </div>
  )
}

/** Both teams and the score: in Team, each half painted in its team's color; in Glass, a card with a thin team edge. */
function Header(props: { game: GameSnapshot; fit: Fit; theme: ThemeName }) {
  const { game, fit } = props
  const big = fit === "page"
  if (props.theme === "team") {
    return (
      <div className="overflow-hidden rounded-card">
        <div className={cn("grid grid-cols-2", big ? "h-40" : "h-24")}>
          {(["away", "home"] as const).map((side) => (
            <div
              key={side}
              className={cn(
                "flex items-center gap-3 px-4 text-white",
                side === "home" && "flex-row-reverse text-right"
              )}
              style={{ background: teamHalf(game[side].team, side) }}
            >
              <span className="shrink-0 drop-shadow-md">
                <TeamLogo team={game[side].team} size={big ? 72 : 40} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("label-caps truncate drop-shadow", big ? "text-xl" : "text-sm")}>
                  {game[side].team.shortName}
                </p>
                <p className="truncate text-white/75 text-xs">{standing(game, side)}</p>
              </div>
              <span className={cn("font-bold font-mono drop-shadow", big ? "text-6xl" : "text-3xl")}>
                {game.scored() ? game[side].score : ""}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-center bg-card-footer px-3 py-1.5 text-muted-foreground text-xs">
          <GameStatus game={game} className="label-caps" />
        </div>
      </div>
    )
  }
  return (
    <div className="relative overflow-hidden rounded-card border border-card-edge backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: teamEdge(game) }}
      />
      <div
        className={cn("grid grid-cols-[1fr_auto_1fr] items-center gap-4", big ? "px-6 py-5" : "px-4 py-3")}
      >
        {(["away", "home"] as const).map((side) => (
          <div
            key={side}
            className={cn(
              "flex min-w-0 items-center gap-3",
              side === "home" && "col-start-3 row-start-1 flex-row-reverse text-right"
            )}
          >
            <TeamLogo team={game[side].team} size={big ? 56 : 32} />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate",
                  big ? "text-xl" : "text-[15px]",
                  trails(game, side) && "text-muted-foreground"
                )}
              >
                {game[side].team.name}
              </p>
              <p className="text-muted-foreground text-xs">{standing(game, side)}</p>
            </div>
            <span
              className={cn(
                "font-mono font-semibold",
                big ? "text-5xl" : "text-2xl",
                trails(game, side) && "text-muted-foreground"
              )}
            >
              {game.scored() ? game[side].score : ""}
            </span>
          </div>
        ))}
        <div className="col-start-2 row-start-1 flex flex-col items-center text-muted-foreground text-xs">
          <GameStatus game={game} />
        </div>
      </div>
    </div>
  )
}

/** Each side's points per period, then its total. */
function Linescore(props: { game: GameSnapshot; stats: GameStats }) {
  const { home, away } = props.stats.linescore
  const periods = Math.max(home.length, away.length)
  const columns = Array.from({ length: periods }, (_, index) => index)
  const baseball = League.of(props.game.league).sport === "baseball"
  const label = (index: number) =>
    baseball ? `${index + 1}` : index < 4 ? `Q${index + 1}` : periods === 5 ? "OT" : `OT${index - 3}`
  return (
    <table className="w-full font-mono text-sm tabular-nums">
      <thead className="text-muted-foreground text-xs">
        <tr>
          <th className="w-16 text-left font-normal" />
          {columns.map((index) => (
            <th key={index} className="py-1 font-normal">
              {label(index)}
            </th>
          ))}
          <th className="py-1 font-normal">{baseball ? "R" : "T"}</th>
        </tr>
      </thead>
      <tbody>
        {(["away", "home"] as const).map((side) => (
          <tr key={side} className="border-border/60 border-t">
            <td className="py-1 text-left">
              <span className="flex items-center gap-2">
                <TeamLogo team={props.game[side].team} size={18} />
                {props.game[side].team.abbreviation}
              </span>
            </td>
            {columns.map((index) => (
              <td key={index} className="text-center">
                {props.stats.linescore[side][index] ?? ""}
              </td>
            ))}
            <td className="text-center font-semibold">{props.game[side].score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Each stat as away, label, home; a stat of plain numbers gets a two-sided bar, in the teams' colors in Team, any other
 * is text alone.
 */
function TeamStats(props: { game: GameSnapshot; rows: ReadonlyArray<TeamStat>; theme: ThemeName }) {
  const team = props.theme === "team"
  const away = team ? teamColor(props.game.away.team) : "var(--muted-foreground)"
  const home = team ? teamColor(props.game.home.team) : "var(--foreground)"
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="grid grid-cols-[4rem_1fr_4rem] text-muted-foreground text-xs">
        <span className="label-caps">{props.game.away.team.abbreviation}</span>
        <span />
        <span className="label-caps text-right">{props.game.home.team.abbreviation}</span>
      </div>
      {props.rows.map((row, index) => {
        const share = GameStats.homeShare(row)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a label can repeat across a sport's stat groups; the rows keep the provider's order.
          <div key={`${row.label}-${index}`} className="flex flex-col gap-1">
            <div className="grid grid-cols-[4rem_1fr_4rem] items-baseline">
              <span className="font-mono">{row.away}</span>
              <span className="truncate text-center text-muted-foreground text-xs">{row.label}</span>
              <span className="text-right font-mono">{row.home}</span>
            </div>
            {Option.match(share, {
              onNone: () => null,
              onSome: (homeShare) => (
                <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
                  <span
                    className="rounded-l-full"
                    style={{ width: `${(1 - homeShare) * 100}%`, background: away }}
                  />
                  <span
                    className="rounded-r-full"
                    style={{ width: `${homeShare * 100}%`, background: home }}
                  />
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Each category's best on either side: the away leader at the left, the home leader mirrored at the right. */
function Leaders(props: { leaders: ReadonlyArray<Leader> }) {
  const categories = [...new Set(props.leaders.map(({ category }) => category))]
  return (
    <div className="flex flex-col gap-2.5 text-sm">
      {categories.map((category) => (
        <div key={category} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          {(["away", "home"] as const).map((side) => {
            const leader = props.leaders.find((each) => each.category === category && each.side === side)
            return (
              <div
                key={side}
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  side === "home" && "col-start-3 row-start-1 flex-row-reverse text-right"
                )}
              >
                {leader !== undefined && (
                  <>
                    {leader.athlete.headshot !== undefined && (
                      <img
                        src={leader.athlete.headshot}
                        alt=""
                        loading="lazy"
                        className="size-9 shrink-0 rounded-full bg-secondary object-cover"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{leader.athlete.name}</p>
                      <p className="truncate font-mono text-muted-foreground text-xs">{leader.line}</p>
                    </div>
                  </>
                )}
              </div>
            )
          })}
          <span className="label-caps col-start-2 row-start-1 text-center text-[10px] text-muted-foreground">
            {category}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The home side's chance after each play, as a line over the game, with 50% marked. */
function WinProbability(props: { game: GameSnapshot; chances: ReadonlyArray<WinChance>; theme: ThemeName }) {
  const width = 400
  const height = 80
  const last = props.chances.length - 1
  const points = props.chances
    .map(({ home }, index) => `${((index / last) * width).toFixed(1)},${((1 - home) * height).toFixed(1)}`)
    .join(" ")
  const latest = props.chances[last]?.home ?? 0.5
  const leading = latest >= 0.5 ? props.game.home.team : props.game.away.team
  const stroke = props.theme === "team" ? teamColor(props.game.home.team) : "currentColor"
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex justify-between text-xs">
        <span className="text-muted-foreground">{props.game.away.team.abbreviation}</span>
        <span className="font-mono">
          {leading.abbreviation} {Math.round(Math.max(latest, 1 - latest) * 100)}%
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-20 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.game.home.team.abbreviation} win probability`}
      >
        <line
          x1={0}
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke="currentColor"
          strokeOpacity={0.3}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="text-muted-foreground text-xs">{props.game.home.team.abbreviation}</span>
    </figure>
  )
}

/** The scoring plays' text, in order, read from the game's plays: every play once, and the live page as it grows. */
function Scoring(props: { game: GameSnapshot; ids: ReadonlyArray<PlayId> }) {
  const latest = useAtomValue(Games.plays(props.game.id)).value
  const every = useAtomValue(Games.everyPlay(props.game.id))
  const known = [...(AsyncResult.isSuccess(every) ? every.value : []), ...latest]
  const byId = new Map(known.map((play) => [play.id, play]))
  const plays = props.ids.flatMap((id) => {
    const play = byId.get(id)
    return play === undefined ? [] : [play]
  })
  const period = League.of(props.game.league).sport === "baseball" ? "Inn " : "Q"
  if (plays.length === 0) return <p className="text-muted-foreground text-xs">Scoring summary loading…</p>
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {plays.map((play) => (
        <li key={play.id} className="grid grid-cols-[5rem_1fr_auto] items-baseline gap-3">
          <span className="font-mono text-muted-foreground text-xs">
            {period}
            {play.period} {play.clock}
          </span>
          <span>{play.text}</span>
          <span className="font-mono text-xs">
            {play.awayScore}–{play.homeScore}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The game's highlights in a row; choosing one plays it in a clip tile. */
function Highlights(props: { highlights: ReadonlyArray<Highlight> }) {
  const input = useAtomSet(DisplayState.display)
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {props.highlights.map((highlight) => (
        <HighlightCard
          key={highlight.id}
          highlight={highlight}
          focused={false}
          onChoose={() => input(DisplayInput.ChosenClip({ highlight }))}
        />
      ))}
    </div>
  )
}
