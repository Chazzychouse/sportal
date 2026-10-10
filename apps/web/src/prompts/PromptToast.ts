import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { useEffect } from "react"
import { toast } from "sonner"
import { nameIn } from "../autopilot/AutopilotState.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as PromptsState from "./PromptsState.ts"
import { PromptInput } from "./PromptsState.ts"

/** Shows the prompt as one toast, updated in place, with Watch and Skip; closes it when there is none. Never timed out. */
export function usePromptToast() {
  const prompt = useAtomValue(PromptsState.prompt)
  const answer = useAtomSet(PromptsState.prompts)
  const { slate } = useAtomValue(LiveStream.live)
  const words = Option.getOrUndefined(Option.map(prompt, (shown) => shown.words(nameIn(slate))))

  useEffect(() => {
    if (words === undefined) {
      toast.dismiss(id)
      return
    }
    toast(words, {
      id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      action: { label: "Watch · Y", onClick: () => answer(PromptInput.Accepted()) },
      cancel: { label: "Skip · N", onClick: () => answer(PromptInput.Dismissed()) }
    })
  }, [words, answer])
}

const id = "prompt"
