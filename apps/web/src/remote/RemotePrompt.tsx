import type { Slate } from "@sportal/domain/Slate"
import { Option } from "effect"
import { Button } from "@/design/button"
import { nameIn } from "../autopilot/AutopilotState.ts"
import type { Prompt } from "../prompts/Prompt.ts"

/** The Display's prompt, pinned at the top of the Remote: its words, and Watch and Skip at a thumb's size. */
export function RemotePrompt(props: {
  prompt: Option.Option<Prompt>
  slate: Slate
  soundReady: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  return Option.match(props.prompt, {
    onNone: () => null,
    onSome: (shown) => (
      <div className="flex flex-col gap-2 rounded-md border border-on-air/60 bg-on-air/10 p-3">
        <p className="text-sm">{shown.words(nameIn(props.slate))}</p>
        <div className="grid grid-cols-2 gap-2">
          <Button className="label-caps min-h-12" onClick={props.onAccept}>
            Watch
          </Button>
          <Button variant="outline" className="label-caps min-h-12" onClick={props.onDismiss}>
            Skip
          </Button>
        </div>
        {!props.soundReady && <p className="text-muted-foreground text-xs">Tap to enable sound</p>}
      </div>
    )
  })
}
