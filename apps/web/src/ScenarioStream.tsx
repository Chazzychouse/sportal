import type { GameId } from "@sportal/domain/Game"
import { useEffect } from "react"
import { Field } from "./game/Field.tsx"
import { useLive, usePlays } from "./hub/HubRuntime.ts"
import { ScenarioStrip } from "./ScenarioStrip.tsx"

/**
 * A scenario's stream of one game, in place of a provider's player: the game's strip and its field from the Hub's
 * live state, a band of moving color bars so a frozen stream shows, and a steady tone of the game's own pitch, so
 * audio focus can be heard moving. The shell mutes it like any stream.
 */
export function ScenarioStream(props: { game: GameId }) {
  const { slate, connection } = useLive()
  const plays = usePlays(props.game)
  const game = slate.find((candidate) => candidate.id === props.game)
  useTone(props.game)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-black text-white">
      {game === undefined ? (
        <p className="grid flex-1 place-items-center font-mono text-[4vmin]">
          {connection._tag === "Connected" ? `No game ${props.game} in this scenario` : "Waiting for the Hub"}
        </p>
      ) : (
        <>
          <ScenarioStrip game={game} />
          <figure className="flex min-h-0 flex-1 flex-col items-center gap-[2vmin] px-[4vmin] pb-[2vmin]">
            <Field key={game.id} game={game} plays={plays} className="min-h-0 w-full flex-1" />
            {game.situation?.lastPlay !== undefined && (
              <figcaption className="text-center text-[3.5vmin] opacity-80">
                {game.situation.lastPlay}
              </figcaption>
            )}
          </figure>
        </>
      )}
      <div className="flex h-[3vmin] shrink-0 items-center justify-end bg-black">
        <div
          aria-hidden
          className="h-full flex-1"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, #c0c0c0 0 20px, #c0c000 20px 40px, #00c0c0 40px 60px, #00c000 60px 80px, #c000c0 80px 100px, #c00000 100px 120px, #0000c0 120px 140px, #101010 140px 160px)",
            animation: "scenario-pan 4s linear infinite"
          }}
        />
        <p className="px-[2vmin] font-mono text-[2vmin] opacity-70">{props.game}</p>
      </div>
    </div>
  )
}

function useTone(game: GameId) {
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
