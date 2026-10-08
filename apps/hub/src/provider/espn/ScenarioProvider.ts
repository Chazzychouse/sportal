import { DateTime, Duration, Effect, Layer, Option, Stream } from "effect"
import { Frame } from "../../Frame.ts"
import { HubConfig } from "../../HubConfig.ts"
import {
  type Scenario,
  Scenarios,
  type ScenarioUnknown,
  type ScenarioUnreadable
} from "../../scenario/Scenarios.ts"
import { Provider } from "../Provider.ts"
import * as EspnDecoder from "./EspnDecoder.ts"

/**
 * The scenario `SPORTAL_SCENARIO` names as the provider, on whatever clock runs it, read by ESPN's decode. Its frames,
 * polls and pushes alike, play in the order they were received, each at its offset from the first, from when its frames
 * are first run; then, or once its frames stop reading partway (logged), it delivers nothing more. A name that is unset
 * or unknown fails, listing the scenarios there are.
 */
export const layer: Layer.Layer<Provider, ScenarioUnknown | ScenarioUnreadable, HubConfig | Scenarios> =
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const { scenario } = yield* HubConfig
      const scenarios = yield* Scenarios
      const name = Option.getOrElse(scenario, () => "")
      const loaded = yield* scenarios.load(name)
      yield* Effect.logInfo(`ScenarioProvider: playing ${name}`)

      return Provider.of({ frames: played(loaded), decode: EspnDecoder.decode })
    })
  )

/**
 * `scenario`'s frames, each received at its offset from the first, counted from when the stream is run. Frames that stop
 * reading partway are logged, and end there.
 */
function played(scenario: Scenario): Stream.Stream<Frame> {
  const { origin } = scenario
  return Stream.unwrap(
    Effect.map(DateTime.now, (start) =>
      scenario.frames.pipe(
        Stream.mapEffect((frame) =>
          Effect.gen(function* () {
            const at = DateTime.addDuration(start, DateTime.distance(origin, frame.receivedAt))
            const now = yield* DateTime.now

            yield* Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero))
            return Frame.movedTo(frame, at)
          })
        ),
        Stream.tapError(({ path, cause }) =>
          Effect.logError(`ScenarioProvider: ${path} stopped reading partway; nothing more plays`, cause)
        ),
        Stream.ignore,
        Stream.concat(Stream.never)
      )
    )
  )
}
