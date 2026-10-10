import type { Slate } from "@sportal/domain/Slate"
import { Option } from "effect"
import { Bell, BellOff } from "lucide-react"
import { Button } from "@/design/button"
import { nameIn } from "../autopilot/AutopilotState.ts"
import type { Prompt } from "./Prompt.ts"
import type { Prompts } from "./Prompts.ts"

/** The top bar's prompts switch: on or off, with the game it is prompting as its tooltip. */
export function PromptsToggle(props: {
  prompts: Prompts
  prompt: Option.Option<Prompt>
  slate: Slate
  onToggle: () => void
}) {
  const { prompts, prompt, slate } = props
  const doing = !prompts.on
    ? "Prompts off"
    : Option.match(prompt, {
        onNone: () => "Prompts on",
        onSome: (shown) => `Prompts on: showing ${nameIn(slate)(shown.game)}`
      })

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-keyshortcuts="P"
      aria-pressed={prompts.on}
      title={`${doing} · P`}
      className={`label-caps text-xs ${prompts.on ? "bg-accent" : ""}`}
      onClick={props.onToggle}
    >
      {prompts.on ? <Bell /> : <BellOff />}
      Prompts
      <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">P</kbd>
    </Button>
  )
}
