import type { ScenarioScript } from "../ScenarioScript.ts"
import { allStoppedButOne } from "./AllStoppedButOne.ts"
import { blowoutAndUpsetBrewing } from "./BlowoutAndUpsetBrewing.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

/** Every written scenario's script, by the name `SPORTAL_SCENARIO` gives it. */
export const scripts: ReadonlyMap<string, ScenarioScript> = new Map(
  [twoMinuteDrillTie, threeRedZonesAtOnce, allStoppedButOne, blowoutAndUpsetBrewing, kickoffWindow].map(
    (script) => [script.name, script] as const
  )
)
