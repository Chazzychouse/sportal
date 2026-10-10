import { DisplayId } from "@sportal/api/DisplayId"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DisplayView } from "./display/DisplayView.tsx"
import { RemoteView } from "./remote/RemoteView.tsx"
import "./theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

// A phone opens /remote/<display-id>, from a Display's join code; every other path is a Display.
const remote = /^\/remote\/([^/]+)$/.exec(window.location.pathname)?.[1]

createRoot(root).render(
  <StrictMode>
    {remote === undefined ? <DisplayView /> : <RemoteView id={DisplayId.make(remote)} />}
  </StrictMode>
)
