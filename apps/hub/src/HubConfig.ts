import { Config, Context, Effect, Layer, type LogLevel, Option, Path, Schema } from "effect"

/** Every setting the Hub reads from its environment, decoded once at startup. */
export class HubConfig extends Context.Service<
  HubConfig,
  {
    readonly port: number
    readonly host: string
    readonly webRoot: Option.Option<string>
    readonly dataDir: string
    readonly scenario: Option.Option<string>
    readonly scenarioSpeed: number
    readonly logLevel: LogLevel.LogLevel
    readonly logFormat: "pretty" | "json"
    readonly version: string
  }
>()("sportal/hub/HubConfig") {
  static readonly layer = Layer.effect(
    HubConfig,
    Effect.gen(function* () {
      const dataDir = yield* Config.String("SPORTAL_DATA_DIR").pipe(Config.option)
      return HubConfig.of({
        port: yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400)),
        // Every interface, so a Remote on the home network can reach the Hub.
        host: yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("0.0.0.0")),
        webRoot: yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option),
        dataDir: Option.isSome(dataDir) ? dataDir.value : yield* HubConfig.defaultDataDir(process.platform),
        scenario: yield* Config.String("SPORTAL_SCENARIO").pipe(Config.option),
        // Zero, a negative speed, or NaN would stall or break the scenario clock.
        scenarioSpeed: yield* Config.schema(
          Schema.Finite.check(Schema.isGreaterThan(0)),
          "SPORTAL_SCENARIO_SPEED"
        ).pipe(Config.withDefault(1)),
        logLevel: yield* Config.LogLevel("SPORTAL_LOG_LEVEL").pipe(Config.withDefault("Info")),
        logFormat: yield* Config.Literals(["pretty", "json"], "SPORTAL_LOG_FORMAT").pipe(
          Config.withDefault("pretty")
        ),
        version: yield* Config.String("SPORTAL_VERSION").pipe(Config.withDefault("dev"))
      })
    })
  )

  /** Where the OS keeps an application's own data. On Windows it is the local folder, so the database never roams. */
  static defaultDataDir(platform: NodeJS.Platform) {
    return Effect.gen(function* () {
      const path = yield* Path.Path
      switch (platform) {
        case "win32": {
          const local = yield* Config.String("LOCALAPPDATA").pipe(Config.option)
          const base = Option.isSome(local)
            ? local.value
            : path.join(yield* Config.String("USERPROFILE"), "AppData", "Local")
          return path.join(base, "Sportal")
        }
        case "darwin":
          return path.join(yield* Config.String("HOME"), "Library", "Application Support", "Sportal")
        default: {
          const xdg = yield* Config.String("XDG_DATA_HOME").pipe(Config.option)
          const base = Option.isSome(xdg)
            ? xdg.value
            : path.join(yield* Config.String("HOME"), ".local", "share")
          return path.join(base, "sportal")
        }
      }
    })
  }
}
