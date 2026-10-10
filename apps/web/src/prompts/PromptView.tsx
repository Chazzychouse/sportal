import type { Slate } from "@sportal/domain/Slate"
import { Option } from "effect"
import { Button } from "@/design/button"
import { nameIn } from "../autopilot/AutopilotState.ts"
import type { Prompt } from "./Prompt.ts"

/** The prompt in the top bar: its words, cut to fit with the whole line as the tooltip, with Watch and Skip. */
export function PromptView(props: {
  prompt: Option.Option<Prompt>
  slate: Slate
  onAccept: () => void
  onDismiss: () => void
}) {
  return Option.match(props.prompt, {
    onNone: () => null,
    onSome: (shown) => {
      const words = shown.words(nameIn(props.slate))
      return (
        <div className="flex min-w-0 items-center gap-2 rounded-md border bg-accent/60 py-0.5 pr-0.5 pl-3">
          <span className="truncate text-xs" title={words}>
            {words}
          </span>
          <Button size="sm" aria-keyshortcuts="Y" className="label-caps text-xs" onClick={props.onAccept}>
            Watch
            <kbd className="ml-1 font-mono text-[10px]">Y</kbd>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-keyshortcuts="N"
            className="label-caps text-xs"
            onClick={props.onDismiss}
          >
            Skip
            <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">N</kbd>
          </Button>
        </div>
      )
    }
  })
}
