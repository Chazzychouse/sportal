import { Schema } from "effect"
import { Screen } from "../screen/Screen.ts"

/** What a Display tells its Remotes: its Screen. */
export class RemoteReport extends Schema.Class<RemoteReport>("sportal/RemoteReport")({
  screen: Screen
}) {}
