import { LeagueId } from "@sportal/domain/League"
import {
  Config,
  Context,
  Effect,
  Layer,
  type LogLevel,
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
    /** Where the corpus keeps its days, from SPORTAL_CORPUS_DIR; `corpus` in the data directory when it is unset. */
    readonly corpusDir: string
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
  static readonly layer = Layer.effect(
    HubConfig,
    Effect.gen(function* () {
      const dataDirSetting = yield* Config.String("SPORTAL_DATA_DIR").pipe(Config.option)
      const dataDir = Option.isSome(dataDirSetting)
        ? dataDirSetting.value
        : yield* HubConfig.defaultDataDir(process.platform)
      const corpusDir = yield* Config.String("SPORTAL_CORPUS_DIR").pipe(Config.option)
      return HubConfig.of({
        port: yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400)),
        // Every interface, so a Remote on the home network can reach the Hub.
        host: yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("0.0.0.0")),
        webRoot: yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option),
        dataDir,
        corpusDir: Option.isSome(corpusDir) ? corpusDir.value : (yield* Path.Path).join(dataDir, "corpus"),
        scenario: yield* Config.String("SPORTAL_SCENARIO").pipe(Config.option),
        // Zero, a negative speed, or NaN would stall or break the scenario clock.
        scenarioSpeed: yield* Config.schema(
          Schema.Finite.check(Schema.isGreaterThan(0)),
          "SPORTAL_SCENARIO_SPEED"
        ).pipe(Config.withDefault(1)),
        scenarioFeedLog: yield* Config.schema(
          Schema.String.check(
            Schema.makeFilter((name) => /^[^/\\]+$/.test(name) && name !== "feed.sqlite", {
              expected: "a file name in the data directory other than feed.sqlite, the game day's feed log"
            })
          ),
          "SPORTAL_SCENARIO_FEED_LOG"
        ).pipe(Config.option),
        logLevel: yield* Config.LogLevel("SPORTAL_LOG_LEVEL").pipe(Config.withDefault("Info")),
        logFormat: yield* Config.Literals(["pretty", "json"], "SPORTAL_LOG_FORMAT").pipe(
          Config.withDefault("pretty")
        ),
        version: yield* Config.String("SPORTAL_VERSION").pipe(Config.withDefault("dev")),
        // "localhost:4318" parses as a URL with scheme "localhost:", so the scheme is checked.
        otlpUrl: yield* Config.schema(
          Schema.URLFromString.check(
            Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
              expected: "an http: or https: URL"
            })
          ),
          "SPORTAL_OTLP_URL"
        ).pipe(Config.option),
        leagues: yield* Config.schema(
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
