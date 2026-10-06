import type { GameSnapshot } from "@sportal/domain/Game"
import { useEffect } from "react"
import { statusText } from "./game/GameStatus.ts"
import { TeamLogo } from "./game/TeamLogo.tsx"
import { useLive } from "./hub/LiveStream.ts"

/**
 * A scenario's stream of one game, in place of a provider's player: the game's live state from the Hub over a
 * moving test pattern, so a frozen stream shows, and a steady tone of the game's own pitch, so audio focus can be
 * heard moving. The shell mutes it like any stream.
 */
export function ScenarioStream(props: { game: string }) {
  const { slate, watchability, connected } = useLive()
  const game = slate.find((candidate) => candidate.id === props.game)
  useTone(props.game)
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <style>{"@keyframes scenario-pan { to { background-position: 160px 0 } }"}</style>
      <div
        aria-hidden
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, #c0c0c0 0 20px, #c0c000 20px 40px, #00c0c0 40px 60px, #00c000 60px 80px, #c000c0 80px 100px, #c00000 100px 120px, #0000c0 120px 140px, #101010 140px 160px)",
          animation: "scenario-pan 4s linear infinite"
        }}
      />
      {game === undefined ? (
        <p className="relative grid h-full place-items-center font-mono text-[4vmin]">
          {connected ? `No game ${props.game} in this scenario` : "Waiting for the Hub"}
        </p>
      ) : (
        <Scorebug game={game} watch={watchability.get(game.id)} />
      )}
      <p className="absolute right-[2vmin] bottom-[2vmin] font-mono text-[2.5vmin] opacity-70">
        {props.game}
      </p>
    </div>
  )
}

function useTone(game: string) {
  useEffect(() => {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    // A semitone in the two octaves above A3, from the game id, so each game has its own note.
    const step = [...game].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 24
    oscillator.frequency.value = 220 * 2 ** (step / 12)
    gain.gain.value = 0.05
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    return () => {
      void context.close()
    }
  }, [game])
}

function Scorebug(props: {
  game: GameSnapshot
  watch: ReturnType<ReturnType<typeof useLive>["watchability"]["get"]>
}) {
  const { game } = props
  const situation = game.situation
  const down = situation?.down
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-[4vmin] font-sans">
      <div className="flex flex-col gap-[2vmin] text-[10vmin] font-semibold tabular-nums leading-none">
        {[game.away, game.home].map((side) => (
          <div key={side.team.id} className="flex items-center gap-[3vmin]">
            <TeamLogo team={side.team} size={64} />
            <span className="w-[20vmin]">{side.team.abbreviation}</span>
            <span>{side.score}</span>
            {situation?.possession === side.team.id && (
              <span className="text-[5vmin] text-yellow-300">●</span>
            )}
          </div>
        ))}
      </div>
      <p className="font-mono text-[6vmin]">{statusText(game)}</p>
      {down !== undefined && situation?.distance !== undefined && situation.yardLine !== undefined && (
        <p className="font-mono text-[5vmin]">
          {["1st", "2nd", "3rd", "4th"][down - 1]} &amp; {situation.distance} · {situation.yardLine} to the
          goal
        </p>
      )}
      {situation?.isRedZone && (
        <p className="rounded bg-red-600 px-[3vmin] py-[1vmin] font-semibold text-[5vmin]">RED ZONE</p>
      )}
      {situation?.lastPlay !== undefined && (
        <p className="px-[4vmin] text-center text-[3.5vmin] opacity-80">{situation.lastPlay}</p>
      )}
      {props.watch !== undefined && (
        <p className="px-[4vmin] text-center font-mono text-[3vmin] opacity-80">
          {props.watch.score}
          {props.watch.lull ? " · lull" : ""}
          {props.watch.reasons.length > 0 ? ` · ${props.watch.reasons.join(" · ")}` : ""}
        </p>
      )}
    </div>
  )
}
