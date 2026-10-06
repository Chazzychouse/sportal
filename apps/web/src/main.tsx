import { GameId } from "@sportal/domain/Game"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DisplayView } from "./display/DisplayView.tsx"
import { RemoteView } from "./remote/RemoteView.tsx"
import { ScenarioStream } from "./ScenarioStream.tsx"
import "./theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

// A phone opens /remote, from the desk's join code; a scenario's stream view opens /scenario-stream/<game>;
// every other path is a Display.
const path = window.location.pathname
const scenarioStream = "/scenario-stream/"
createRoot(root).render(
  <StrictMode>
    {path.startsWith("/remote") ? (
      <RemoteView />
    ) : path.startsWith(scenarioStream) ? (
      <ScenarioStream game={GameId.make(decodeURIComponent(path.slice(scenarioStream.length)))} />
    ) : (
      <DisplayView />
    )}
  </StrictMode>
)
