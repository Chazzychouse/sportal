import { LeagueId } from "@sportal/domain/League"
import {
  Config,
  ConfigProvider,
  Context,
  Layer,
  type LogLevel,
  type Option,
  Schema,
  SchemaGetter
} from "effect"

// "localhost:4318" parses as a URL with scheme "localhost:", so the scheme is checked.
const OtlpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
    expected: "an http: or https: URL"
  })
)

const LeagueList = Schema.String.pipe(
  Schema.decodeTo(Schema.Array(Schema.Trim.pipe(Schema.decodeTo(LeagueId))).check(Schema.isMinLength(1)), {
    decode: SchemaGetter.split(),
    encode: SchemaGetter.transform((leagues) => leagues.join(","))
  })
)

/** Every setting the Hub reads from its environment, decoded once at startup. */
export class HubConfig extends Context.Service<
  HubConfig,
  {
    readonly port: number
    readonly host: string
    readonly webRoot: Option.Option<string>
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
    Config.all({
      port: Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400)),
      // Every interface, so other devices on the home network can reach the Hub.
      host: Config.String("SPORTAL_HOST").pipe(Config.withDefault("0.0.0.0")),
      webRoot: Config.option(Config.String("SPORTAL_WEB_ROOT")),
      logLevel: Config.LogLevel("SPORTAL_LOG_LEVEL").pipe(Config.withDefault("Info")),
      logFormat: Config.Literals(["pretty", "json"], "SPORTAL_LOG_FORMAT").pipe(Config.withDefault("pretty")),
      version: Config.String("SPORTAL_VERSION").pipe(Config.withDefault("dev")),
      otlpUrl: Config.option(Config.schema(OtlpUrl, "SPORTAL_OTLP_URL")),
      leagues: Config.schema(LeagueList, "SPORTAL_LEAGUES").pipe(Config.withDefault(LeagueId.literals))
    })
  )

  /** HubConfig for a test, read from exactly `env`, and nothing from the machine running it. */
  static readonly layerTest = (env: Record<string, string>): Layer.Layer<HubConfig, Config.ConfigError> =>
    HubConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
}
