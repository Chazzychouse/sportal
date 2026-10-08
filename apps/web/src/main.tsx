import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DisplayView } from "./display/DisplayView.tsx"
import { RemoteView } from "./remote/RemoteView.tsx"
import "./theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

// A phone opens /remote, from the desk's join code; every other path is a Display.
createRoot(root).render(
  <StrictMode>{window.location.pathname.startsWith("/remote") ? <RemoteView /> : <DisplayView />}</StrictMode>
)
