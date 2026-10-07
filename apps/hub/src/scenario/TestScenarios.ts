import * as EspnScript from "../provider/espn/EspnScript.ts"
import { Scenarios } from "./Scenarios.ts"

/** The written scenarios as `HubMode` plays them: each script written as ESPN's frames. */
export const writtenScenarios = Scenarios.written(EspnScript.scenarioOf)
