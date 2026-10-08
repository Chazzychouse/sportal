import { LeagueId } from "@sportal/domain/League"
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  type LogLevel,
  type Option,
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
    readonly scenario: Option.Option<string>
    readonly scenarioSpeed: number
    readonly logLevel: LogLevel.LogLevel
    readonly logFormat: "pretty" | "json"
    readonly version: string
    readonly otlpUrl: Option.Option<URL>
    /** The leagues the provider follows, from SPORTAL_LEAGUES as a comma-separated list; every league when it is unset. */
    readonly leagues: ReadonlyArray<LeagueId>
  }
>()("sportal/hub/HubConfig") {
  static readonly layer: Layer.Layer<HubConfig, Config.ConfigError> = Layer.effect(
    HubConfig,
    Effect.gen(function* () {
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
        scenario,
        scenarioSpeed,
        logLevel,
        logFormat,
        version,
        otlpUrl,
        leagues
      })
    })
  )

  /** HubConfig for a test, read from exactly `env`, and nothing from the machine running it. */
  static readonly layerTest = (env: Record<string, string>): Layer.Layer<HubConfig, Config.ConfigError> =>
    HubConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
}
