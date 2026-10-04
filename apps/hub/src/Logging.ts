import { Effect, Layer, Logger, References } from "effect"
import { HubConfig } from "./HubConfig.ts"

/** The Hub's minimum log level, and its format: Effect's console logger, or one JSON object per line. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { logLevel, logFormat } = yield* HubConfig
    return Layer.mergeAll(
      Layer.succeed(References.MinimumLogLevel, logLevel),
      logFormat === "json" ? Logger.layer([Logger.consoleJson]) : Layer.empty
    )
  })
)
