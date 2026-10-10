import { Schema } from "effect"
import { Autopilot } from "../autopilot/Autopilot.ts"
import { Prompt } from "../prompts/Prompt.ts"
import { Prompts } from "../prompts/Prompts.ts"
import { Screen } from "../screen/Screen.ts"

/** What a Display tells its Remotes: its Screen, its autopilot and prompts, and the prompt it is showing. */
export class RemoteReport extends Schema.Class<RemoteReport>("sportal/RemoteReport")({
  screen: Screen,
  autopilot: Autopilot,
  prompts: Prompts,
  prompt: Schema.OptionFromOptionalKey(Prompt)
}) {}
