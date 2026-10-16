import { Config, ConfigProvider, Context, Layer, type LogLevel, type Option } from "effect"

export class HubConfig extends Context.Service<
  HubConfig,
  {
    readonly port: number
    readonly host: string
    readonly webRoot: Option.Option<string>
    readonly logLevel: LogLevel.LogLevel
    readonly logFormat: "pretty" | "json"
    readonly version: string
    /** The zone whose calendar says what day it is: ESPN's scoreboard days are US Eastern. */
    readonly timeZone: string
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
      timeZone: Config.String("SPORTAL_TIME_ZONE").pipe(Config.withDefault("America/New_York"))
    })
  )

  static readonly layerTest = (env: Record<string, string>): Layer.Layer<HubConfig, Config.ConfigError> =>
    HubConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
}
