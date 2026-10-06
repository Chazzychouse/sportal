import type { Scenario } from "../Scenario.ts"
import { allStoppedButOne } from "./AllStoppedButOne.ts"
import { blowoutAndUpsetBrewing } from "./BlowoutAndUpsetBrewing.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

/** Every written scenario, by the name `SPORTAL_SCENARIO` gives it. */
export const scenarios: ReadonlyMap<string, Scenario> = new Map(
  [twoMinuteDrillTie, threeRedZonesAtOnce, allStoppedButOne, blowoutAndUpsetBrewing, kickoffWindow].map(
    (scenario) => [scenario.name, scenario] as const
  )
)
