import { NodePath } from "@effect/platform-node"
import { LeagueId } from "@sportal/domain/League"
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  type LogLevel,
  Match,
  Option,
  Path,
  Schema,
  SchemaTransformation
} from "effect"

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
    /** A file in the data directory for a scenario's feed log; none keeps it in memory. Never the game day's log. */
    readonly scenarioFeedLog: Option.Option<string>
    readonly logLevel: LogLevel.LogLevel
    readonly logFormat: "pretty" | "json"
    readonly version: string
    readonly otlpUrl: Option.Option<URL>
    /** The leagues Ingest follows, from SPORTAL_LEAGUES as a comma-separated list; every league when it is unset. */
    readonly leagues: ReadonlyArray<LeagueId>
  }
>()("sportal/hub/HubConfig") {
  static readonly layer: Layer.Layer<HubConfig, Config.ConfigError, Path.Path> = Layer.effect(
    HubConfig,
    Effect.gen(function* () {
      const dataDirSetting = yield* Config.String("SPORTAL_DATA_DIR").pipe(Config.option)
      const dataDir = yield* Option.match(dataDirSetting, {
        onSome: Effect.succeed,
        onNone: () => HubConfig.defaultDataDir(process.platform)
      })
      const port = yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400))
      // Every interface, so a Remote on the home network can reach the Hub.
      const host = yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("0.0.0.0"))
      const webRoot = yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option)
      const scenario = yield* Config.String("SPORTAL_SCENARIO").pipe(Config.option)
      // Zero, a negative speed, or NaN would stall or break the scenario clock.
      const scenarioSpeed = yield* Config.schema(
        Schema.Finite.check(Schema.isGreaterThan(0)),
        "SPORTAL_SCENARIO_SPEED"
      ).pipe(Config.withDefault(1))
      const scenarioFeedLog = yield* Config.schema(
        Schema.String.check(
          Schema.makeFilter((name) => /^[^/\\]+$/.test(name) && name !== "feed.sqlite", {
            expected: "a file name in the data directory other than feed.sqlite, the game day's feed log"
          })
        ),
        "SPORTAL_SCENARIO_FEED_LOG"
      ).pipe(Config.option)
      const logLevel = yield* Config.LogLevel("SPORTAL_LOG_LEVEL").pipe(Config.withDefault("Info"))
      const logFormat = yield* Config.Literals(["pretty", "json"], "SPORTAL_LOG_FORMAT").pipe(
        Config.withDefault("pretty")
      )
      const version = yield* Config.String("SPORTAL_VERSION").pipe(Config.withDefault("dev"))
      // "localhost:4318" parses as a URL with scheme "localhost:", so the scheme is checked.
      const otlpUrl = yield* Config.schema(
        Schema.URLFromString.check(
          Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
            expected: "an http: or https: URL"
          })
        ),
        "SPORTAL_OTLP_URL"
      ).pipe(Config.option)
      const leagues = yield* Config.schema(
        Schema.String.pipe(
          Schema.decodeTo(
            Schema.Array(Schema.String),
            SchemaTransformation.transform<ReadonlyArray<string>, string>({
              decode: (list) => list.split(",").map((league) => league.trim()),
              encode: (leagues) => leagues.join(",")
            })
          ),
          Schema.decodeTo(Schema.Array(LeagueId).check(Schema.isMinLength(1)))
        ),
        "SPORTAL_LEAGUES"
      ).pipe(Config.withDefault(LeagueId.literals))

      return HubConfig.of({
        port,
        host,
        webRoot,
        dataDir,
        scenario,
        scenarioSpeed,
        scenarioFeedLog,
        logLevel,
        logFormat,
        version,
        otlpUrl,
        leagues
      })
    })
  )

  /** HubConfig for a test, read from exactly `env` over a fan's home folder, and nothing from the machine running it. */
  static readonly layerTest = (env: Record<string, string>): Layer.Layer<HubConfig, Config.ConfigError> => {
    const variables = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...fanHome, ...env } }))
    return HubConfig.layer.pipe(Layer.provide(Layer.mergeAll(variables, NodePath.layer)))
  }

  /** Where the OS keeps an application's own data. On Windows it is the local folder, so the database never roams. */
  static readonly defaultDataDir = Effect.fn("HubConfig.defaultDataDir")(function* (
    platform: NodeJS.Platform
  ) {
    const path = yield* Path.Path
    return yield* Match.value(platform).pipe(
      Match.when("win32", () =>
        Effect.gen(function* () {
          const local = yield* Config.String("LOCALAPPDATA").pipe(Config.option)
          if (Option.isSome(local)) return path.join(local.value, "Sportal")

          const profile = yield* Config.String("USERPROFILE")
          return path.join(profile, "AppData", "Local", "Sportal")
        })
      ),
      Match.when("darwin", () =>
        Effect.gen(function* () {
          const home = yield* Config.String("HOME")
          return path.join(home, "Library", "Application Support", "Sportal")
        })
      ),
      Match.orElse(() =>
        Effect.gen(function* () {
          const xdg = yield* Config.String("XDG_DATA_HOME").pipe(Config.option)
          if (Option.isSome(xdg)) return path.join(xdg.value, "sportal")

          const home = yield* Config.String("HOME")
          return path.join(home, ".local", "share", "sportal")
        })
      )
    )
  })
}

// A fan's home folder on every OS, so the default data directory resolves without the test machine's own.
const fanHome = { HOME: "/home/fan", USERPROFILE: "C:\\Users\\fan" }
