import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DisplayView } from "./display/DisplayView.tsx"
import "./theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <DisplayView />
  </StrictMode>
)
