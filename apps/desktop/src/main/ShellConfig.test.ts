import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { afterEach, beforeEach } from "vitest"
import { ShellConfig } from "./ShellConfig.ts"

describe("ShellConfig", () => {
  const was = { defaultApp: process.defaultApp, resourcesPath: process.resourcesPath }
  beforeEach(() => {
    Object.assign(process, { resourcesPath: join("/opt", "Sportal", "resources") })
  })
  afterEach(() => {
    Object.assign(process, was)
  })

  it.effect("should start no Hub when SPORTAL_HUB_URL names one", () =>
    Effect.gen(function* () {
      const config = yield* configOf({ SPORTAL_HUB_URL: "http://192.168.0.5:4400" })

      assert.strictEqual(config.hubUrl, "http://192.168.0.5:4400")
      assert.isTrue(Option.isNone(config.embeddedHub))
    })
  )

  it.effect("should start the installed app's Hub from its resources on port 4400", () =>
    Effect.gen(function* () {
      Object.assign(process, { defaultApp: false })

      const config = yield* configOf({})

      assert.strictEqual(config.hubUrl, "http://127.0.0.1:4400")
      assert.deepStrictEqual(
        config.embeddedHub,
        Option.some({
          script: join("/opt", "Sportal", "resources", "hub", "hub.mjs"),
          webRoot: join("/opt", "Sportal", "resources", "web"),
          port: 4400
        })
      )
    })
  )

  it.effect("should start the Hub's build when run from the repository", () =>
    Effect.gen(function* () {
      Object.assign(process, { defaultApp: true })

      const config = yield* configOf({})

      const script = Option.map(config.embeddedHub, (hub) => hub.script)
      assert.isTrue(Option.getOrThrow(script).endsWith(join("hub", "dist", "hub.mjs")))
    })
  )

  it.effect("should start the Hub on SPORTAL_PORT and load it there", () =>
    Effect.gen(function* () {
      const config = yield* configOf({ SPORTAL_PORT: "4410" })

      assert.strictEqual(config.hubUrl, "http://127.0.0.1:4410")
      assert.deepStrictEqual(
        Option.map(config.embeddedHub, (hub) => hub.port),
        Option.some(4410)
      )
    })
  )
})

function configOf(env: Record<string, string>) {
  const provider = ConfigProvider.layer(ConfigProvider.fromEnv({ env }))
  return Effect.service(ShellConfig).pipe(Effect.provide(ShellConfig.layer.pipe(Layer.provide(provider))))
}
