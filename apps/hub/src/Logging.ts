import { Effect, Layer, Logger, References } from "effect"
import { HubConfig } from "./HubConfig.ts"

/** The Hub's console logs: the minimum level, and JSON lines instead of the pretty format when the config says so. */
export const layer: Layer.Layer<never, never, HubConfig> = Layer.unwrap(
  Effect.gen(function* () {
    const { logLevel, logFormat } = yield* HubConfig
    return Layer.mergeAll(
      Layer.succeed(References.MinimumLogLevel, logLevel),
      logFormat === "json" ? Logger.layer([Logger.consoleJson]) : Layer.empty
    )
  })
)
