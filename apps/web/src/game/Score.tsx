import type { GameSnapshot } from "@sportal/domain/Game"
import { cn } from "@/design/ClassName"
import { TeamLogo } from "./TeamLogo.tsx"

/**
 * One team's cells of a score row: logo, rank and abbreviation, and score. The score shows once the game has one,
 * and then the trailing side is muted. The cells are bare, for the caller's grid or flex row; `"board"` is the
 * large form, with the rank in a cell of its own.
 */
export function Score(props: { game: GameSnapshot; side: "home" | "away"; size?: "row" | "board" }) {
  const { game } = props
  const team = game[props.side]
  const scored = game.scored()
  const muted = scored && team.score < game[props.side === "home" ? "away" : "home"].score
  const mute = muted ? "text-muted-foreground" : ""
  const score = scored ? team.score : null
  if (props.size === "board")
    return (
      <>
        <TeamLogo team={team.team} size={40} />
        <span className={cn("label-caps text-right text-3xl", mute)}>{team.team.abbreviation}</span>
        <span className={cn("font-mono font-semibold text-4xl", mute)}>{score}</span>
        <span className="text-muted-foreground text-xs">
          {team.ranking === undefined ? "" : `#${team.ranking}`}
        </span>
      </>
    )
  return (
    <>
      <TeamLogo team={team.team} size={16} />
      <span className={cn("truncate font-semibold", mute)}>
        {team.ranking !== undefined && (
          <span className="mr-0.5 font-normal text-[9px] text-muted-foreground">{team.ranking}</span>
        )}
        {team.team.abbreviation}
      </span>
      <span className={cn("ml-auto text-right", mute)}>{score}</span>
    </>
  )
}

/** The score as one line of text: "KC 21–14 BUF". */
export function scoreline(game: GameSnapshot): string {
  return `${game.away.team.abbreviation} ${game.away.score}–${game.home.score} ${game.home.team.abbreviation}`
}
