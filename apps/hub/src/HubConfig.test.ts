import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { LeagueId } from "@sportal/domain/League"
import { Effect, Option } from "effect"
import { HubConfig } from "./HubConfig.ts"
import { home, inEnv, withEnv } from "./TestHubConfig.ts"

describe("HubConfig", () => {
  it.effect("has a default for every setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig
      assert.strictEqual(config.port, 4400)
      assert.strictEqual(config.host, "0.0.0.0")
      assert.isTrue(Option.isNone(config.webRoot))
      const expected = yield* HubConfig.defaultDataDir(process.platform).pipe(
        Effect.provide(inEnv(home, NodePath.layer))
      )
      assert.strictEqual(config.dataDir, expected)
      assert.isTrue(Option.isNone(config.scenario))
      assert.strictEqual(config.scenarioSpeed, 1)
      assert.isTrue(Option.isNone(config.scenarioFeedLog), "a scenario's feed log is in memory")
      assert.strictEqual(config.logLevel, "Info")
      assert.strictEqual(config.logFormat, "pretty")
      assert.strictEqual(config.version, "dev")
      assert.isTrue(Option.isNone(config.otlpUrl))
      assert.deepStrictEqual(config.leagues, LeagueId.literals)
    }).pipe(Effect.provide(withEnv({})))
  )

  it.effect("reads each setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig
      assert.strictEqual(config.port, 5000)
      assert.strictEqual(config.host, "127.0.0.1")
      assert.deepStrictEqual(config.webRoot, Option.some("/srv/web"))
      assert.strictEqual(config.dataDir, "/data")
      assert.deepStrictEqual(config.scenario, Option.some("two-minute-drill-tie"))
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
    }).pipe(
      Effect.provide(
        withEnv({
          SPORTAL_PORT: "5000",
          SPORTAL_HOST: "127.0.0.1",
          SPORTAL_WEB_ROOT: "/srv/web",
          SPORTAL_DATA_DIR: "/data",
          SPORTAL_SCENARIO: "two-minute-drill-tie",
          SPORTAL_SCENARIO_SPEED: "10",
          SPORTAL_SCENARIO_FEED_LOG: "scenario.sqlite",
          SPORTAL_LOG_LEVEL: "Debug",
          SPORTAL_LOG_FORMAT: "json",
          SPORTAL_VERSION: "1.2.3",
          SPORTAL_OTLP_URL: "http://localhost:4318",
          SPORTAL_LEAGUES: "fbs"
        })
      )
    )
  )

  it.effect("reads a list of leagues, ignoring the spaces around each", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig
      assert.deepStrictEqual(config.leagues, ["nfl", "fbs"])
    }).pipe(Effect.provide(withEnv({ SPORTAL_LEAGUES: " nfl , fbs " })))
  )

  for (const [name, value] of [
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
  ] as const) {
    it.effect(`refuses ${name}=${value}, naming the setting`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.gen(function* () {
          return yield* HubConfig
        }).pipe(Effect.provide(withEnv({ [name]: value })), Effect.flip)
        assert.include(error.message, name)
      })
    )
  }
})

describe("HubConfig.defaultDataDir", () => {
  it.effect("is under XDG_DATA_HOME on Linux, when it is set and not empty", () =>
    Effect.gen(function* () {
      const dir = (env: Record<string, string>) =>
        HubConfig.defaultDataDir("linux").pipe(Effect.provide(inEnv(env, NodePath.layerPosix)))
      assert.strictEqual(yield* dir({ HOME: "/home/fan", XDG_DATA_HOME: "/data/xdg" }), "/data/xdg/sportal")
      assert.strictEqual(yield* dir({ HOME: "/home/fan" }), "/home/fan/.local/share/sportal")
      assert.strictEqual(
        yield* dir({ HOME: "/home/fan", XDG_DATA_HOME: "" }),
        "/home/fan/.local/share/sportal"
      )
    })
  )

  it.effect("is in Application Support on macOS", () =>
    Effect.gen(function* () {
      const dir = yield* HubConfig.defaultDataDir("darwin").pipe(
        Effect.provide(inEnv({ HOME: "/Users/fan" }, NodePath.layerPosix))
      )
      assert.strictEqual(dir, "/Users/fan/Library/Application Support/Sportal")
    })
  )

  it.effect("is under LOCALAPPDATA on Windows, never the roaming folder", () =>
    Effect.gen(function* () {
      const dir = (env: Record<string, string>) =>
        HubConfig.defaultDataDir("win32").pipe(Effect.provide(inEnv(env, NodePath.layerWin32)))
      assert.strictEqual(
        yield* dir({ USERPROFILE: "C:\\Users\\fan", LOCALAPPDATA: "D:\\Local" }),
        "D:\\Local\\Sportal"
      )
      assert.strictEqual(
        yield* dir({ USERPROFILE: "C:\\Users\\fan" }),
        "C:\\Users\\fan\\AppData\\Local\\Sportal"
      )
    })
  )

  it.effect("names HOME when it is needed and missing", () =>
    Effect.gen(function* () {
      const error = yield* HubConfig.defaultDataDir("linux").pipe(
        Effect.provide(inEnv({}, NodePath.layerPosix)),
        Effect.flip
      )
      assert.include(error.message, "HOME")
    })
  )
})
