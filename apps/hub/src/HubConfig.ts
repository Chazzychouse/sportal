import { Config, ConfigProvider, Context, Layer, type LogLevel, type Option, Schema } from "effect"

const OtlpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
    expected: "an http: or https: URL"
  })
)

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
  }
>()("sportal/hub/HubConfig") {
  static readonly layer: Layer.Layer<HubConfig, Config.ConfigError> = Layer.effect(
    HubConfig,
    Config.all({
      port: Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400)),
      host: Config.String("SPORTAL_HOST").pipe(Config.withDefault("0.0.0.0")),
      webRoot: Config.option(Config.String("SPORTAL_WEB_ROOT")),
      logLevel: Config.LogLevel("SPORTAL_LOG_LEVEL").pipe(Config.withDefault("Info")),
      logFormat: Config.Literals(["pretty", "json"], "SPORTAL_LOG_FORMAT").pipe(Config.withDefault("pretty")),
      version: Config.String("SPORTAL_VERSION").pipe(Config.withDefault("dev")),
      otlpUrl: Config.option(Config.schema(OtlpUrl, "SPORTAL_OTLP_URL"))
    })
  )

  static readonly layerTest = (env: Record<string, string>): Layer.Layer<HubConfig, Config.ConfigError> =>
    HubConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
}
