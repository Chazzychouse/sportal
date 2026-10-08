import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { LeagueId } from "@sportal/domain/League"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { HubConfig } from "./HubConfig.ts"

describe("HubConfig", () => {
  it.effect("should have a default for every setting", () =>
    Effect.gen(function* () {
      const expectedDataDir = yield* dataDirOn(process.platform, home, NodePath.layer)

      const config = yield* HubConfig

      assert.strictEqual(config.port, 4400)
      assert.strictEqual(config.host, "0.0.0.0")
      assert.isTrue(Option.isNone(config.webRoot))
      assert.strictEqual(config.dataDir, expectedDataDir)
      assert.isTrue(Option.isNone(config.scenario))
      assert.strictEqual(config.scenarioSpeed, 1)
      assert.isTrue(Option.isNone(config.scenarioFeedLog), "a scenario's feed log is in memory")
      assert.strictEqual(config.logLevel, "Info")
      assert.strictEqual(config.logFormat, "pretty")
      assert.strictEqual(config.version, "dev")
      assert.isTrue(Option.isNone(config.otlpUrl))
      assert.deepStrictEqual(config.leagues, LeagueId.literals)
    }).pipe(Effect.provide(HubConfig.layerTest(home)))
  )

  it.effect("should read each setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig

      assert.strictEqual(config.port, 5000)
      assert.strictEqual(config.host, "127.0.0.1")
      assert.deepStrictEqual(config.webRoot, Option.some("/srv/web"))
      assert.strictEqual(config.dataDir, "/data")
      assert.deepStrictEqual(config.scenario, Option.some("bogus-clock-two-minute"))
      assert.strictEqual(config.scenarioSpeed, 10)
      assert.deepStrictEqual(config.scenarioFeedLog, Option.some("scenario.sqlite"))
      assert.strictEqual(config.logLevel, "Debug")
      assert.strictEqual(config.logFormat, "json")
      assert.strictEqual(config.version, "1.2.3")
      assert.deepStrictEqual(
        Option.map(config.otlpUrl, (url) => url.href),
        Option.some("http://localhost:4318/")
      )
      assert.deepStrictEqual(config.leagues, ["fbs"])
    }).pipe(Effect.provide(HubConfig.layerTest(everySetting)))
  )

  it.effect("should read a list of leagues, ignoring the spaces around each", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig

      assert.deepStrictEqual(config.leagues, ["nfl", "fbs"])
    }).pipe(Effect.provide(HubConfig.layerTest({ SPORTAL_LEAGUES: " nfl , fbs " })))
  )

  it.effect.each([
    ["SPORTAL_PORT", "eighty"],
    ["SPORTAL_SCENARIO_SPEED", "0"],
    ["SPORTAL_SCENARIO_SPEED", "NaN"],
    ["SPORTAL_LOG_LEVEL", "Loud"],
    ["SPORTAL_LOG_FORMAT", "xml"],
    ["SPORTAL_OTLP_URL", "not a url"],
    ["SPORTAL_OTLP_URL", "localhost:4318"],
    ["SPORTAL_SCENARIO_FEED_LOG", "feed.sqlite"],
    ["SPORTAL_SCENARIO_FEED_LOG", "../elsewhere.sqlite"],
    ["SPORTAL_LEAGUES", "mlb"],
    ["SPORTAL_LEAGUES", " , "]
  ] as const)("should refuse %s=%s, naming the setting", ([name, value]) =>
    Effect.gen(function* () {
      const config = Effect.service(HubConfig).pipe(Effect.provide(HubConfig.layerTest({ [name]: value })))

      const error = yield* Effect.flip(config)

      assert.include(error.message, name)
    })
  )
})

describe("HubConfig.defaultDataDir", () => {
  it.effect("should be under XDG_DATA_HOME on Linux, when it is set", () =>
    Effect.gen(function* () {
      const env = { HOME: "/home/fan", XDG_DATA_HOME: "/data/xdg" }

      const dir = yield* dataDirOn("linux", env, NodePath.layerPosix)

      assert.strictEqual(dir, "/data/xdg/sportal")
    })
  )

  it.effect.each([
    ["missing", { HOME: "/home/fan" }],
    ["empty", { HOME: "/home/fan", XDG_DATA_HOME: "" }]
  ] as const)("should be under the home folder on Linux when XDG_DATA_HOME is %s", ([_name, env]) =>
    Effect.gen(function* () {
      const dir = yield* dataDirOn("linux", env, NodePath.layerPosix)

      assert.strictEqual(dir, "/home/fan/.local/share/sportal")
    })
  )

  it.effect("should be in Application Support on macOS", () =>
    Effect.gen(function* () {
      const env = { HOME: "/Users/fan" }

      const dir = yield* dataDirOn("darwin", env, NodePath.layerPosix)

      assert.strictEqual(dir, "/Users/fan/Library/Application Support/Sportal")
    })
  )

  it.effect("should be under LOCALAPPDATA on Windows, when it is set", () =>
    Effect.gen(function* () {
      const env = { USERPROFILE: "C:\\Users\\fan", LOCALAPPDATA: "D:\\Local" }

      const dir = yield* dataDirOn("win32", env, NodePath.layerWin32)

      assert.strictEqual(dir, "D:\\Local\\Sportal")
    })
  )

  it.effect("should be in the local app data under the profile on Windows, never the roaming folder", () =>
    Effect.gen(function* () {
      const env = { USERPROFILE: "C:\\Users\\fan" }

      const dir = yield* dataDirOn("win32", env, NodePath.layerWin32)

      assert.strictEqual(dir, "C:\\Users\\fan\\AppData\\Local\\Sportal")
    })
  )

  it.effect("should name HOME when it is needed and missing", () =>
    Effect.gen(function* () {
      const dir = dataDirOn("linux", {}, NodePath.layerPosix)

      const error = yield* Effect.flip(dir)

      assert.include(error.message, "HOME")
    })
  )
})

/** A value for every setting, none of them its default. */
const everySetting = {
  SPORTAL_PORT: "5000",
  SPORTAL_HOST: "127.0.0.1",
  SPORTAL_WEB_ROOT: "/srv/web",
  SPORTAL_DATA_DIR: "/data",
  SPORTAL_SCENARIO: "bogus-clock-two-minute",
  SPORTAL_SCENARIO_SPEED: "10",
  SPORTAL_SCENARIO_FEED_LOG: "scenario.sqlite",
  SPORTAL_LOG_LEVEL: "Debug",
  SPORTAL_LOG_FORMAT: "json",
  SPORTAL_VERSION: "1.2.3",
  SPORTAL_OTLP_URL: "http://localhost:4318",
  SPORTAL_LEAGUES: "fbs"
}

/** The default data directory on `platform`, read from exactly the variables `env` with `path`'s separators. */
function dataDirOn(platform: NodeJS.Platform, env: Record<string, string>, path: typeof NodePath.layer) {
  return HubConfig.defaultDataDir(platform).pipe(Effect.provide(inEnv(env, path)))
}

/** Exactly these variables as the configuration, beside `path`, and nothing from the machine running the test. */
function inEnv(env: Record<string, string>, path: typeof NodePath.layer) {
  return Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), path)
}

// A fan's home folder on every OS, given explicitly so the default data directory is the one expected.
const home = { HOME: "/home/fan", USERPROFILE: "C:\\Users\\fan" }
