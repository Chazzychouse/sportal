import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { HubConfig } from "./HubConfig.ts"

describe("HubConfig", () => {
  it.effect("should have a default for every setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig

      assert.strictEqual(config.port, 4400)
      assert.strictEqual(config.host, "0.0.0.0")
      assert.isTrue(Option.isNone(config.webRoot))
      assert.strictEqual(config.logLevel, "Info")
      assert.strictEqual(config.logFormat, "pretty")
      assert.strictEqual(config.version, "dev")
      assert.isTrue(Option.isNone(config.otlpUrl))
    }).pipe(Effect.provide(HubConfig.layerTest({})))
  )

  it.effect("should read each setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig

      assert.strictEqual(config.port, 5000)
      assert.strictEqual(config.host, "127.0.0.1")
      assert.deepStrictEqual(config.webRoot, Option.some("/srv/web"))
      assert.strictEqual(config.logLevel, "Debug")
      assert.strictEqual(config.logFormat, "json")
      assert.strictEqual(config.version, "1.2.3")
      assert.deepStrictEqual(
        Option.map(config.otlpUrl, (url) => url.href),
        Option.some("http://localhost:4318/")
      )
    }).pipe(Effect.provide(HubConfig.layerTest(everySetting)))
  )

  it.effect.each([
    ["SPORTAL_PORT", "eighty"],
    ["SPORTAL_LOG_LEVEL", "Loud"],
    ["SPORTAL_LOG_FORMAT", "xml"],
    ["SPORTAL_OTLP_URL", "not a url"],
    ["SPORTAL_OTLP_URL", "localhost:4318"]
  ] as const)("should refuse %s=%s, naming the setting", ([name, value]) =>
    Effect.gen(function* () {
      const config = Effect.service(HubConfig).pipe(Effect.provide(HubConfig.layerTest({ [name]: value })))

      const error = yield* Effect.flip(config)

      assert.include(error.message, name)
    })
  )
})

/** A value for every setting, none of them its default. */
const everySetting = {
  SPORTAL_PORT: "5000",
  SPORTAL_HOST: "127.0.0.1",
  SPORTAL_WEB_ROOT: "/srv/web",
  SPORTAL_LOG_LEVEL: "Debug",
  SPORTAL_LOG_FORMAT: "json",
  SPORTAL_VERSION: "1.2.3",
  SPORTAL_OTLP_URL: "http://localhost:4318"
}
