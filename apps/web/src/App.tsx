import { useState } from "react"
import { dispatch } from "./hub/HubClient.ts"
import { useLive } from "./hub/Live.ts"
import { SlateView } from "./slate/SlateView.tsx"
import { StageView } from "./stage/StageView.tsx"

export function App() {
  const live = useLive()
  // The tile the next picked game goes to. Local to this client: it is a cursor, not shared state.
  const [selected, setSelected] = useState(0)

  return (
    <div className="grid h-screen grid-cols-[22rem_1fr] bg-neutral-950 text-neutral-100">
      <SlateView
        slate={live.slate}
        connected={live.connected}
        onPick={(game) => dispatch({ _tag: "Assign", tile: selected, game: game.id })}
      />
      <StageView
        stage={live.stage}
        slate={live.slate}
        connected={live.connected}
        selected={selected}
        onSelect={setSelected}
      />
    </div>
  )
}
