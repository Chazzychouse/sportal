import { join } from "node:path"
import { Config, Context, Effect, Layer, Option } from "effect"

/** Every setting the desktop shell reads from its environment, decoded once at startup. */
export class ShellConfig extends Context.Service<
  ShellConfig,
  {
    readonly hubUrl: string
    /** The Hub the shell starts itself, when no address is given: its bundled script and the web UI it serves. */
    readonly embeddedHub: Option.Option<{
      readonly script: string
      readonly webRoot: string
      readonly port: number
    }>
  }
>()("sportal/desktop/main/ShellConfig") {
  /**
   * SPORTAL_HUB_URL names a Hub already running, and the shell starts none. Without it the shell starts the Hub it
   * ships with, on SPORTAL_PORT (default 4400): from the installed app's resources, or, run from the repository, from
   * the Hub's and the web UI's builds.
   */
  static readonly layer: Layer.Layer<ShellConfig, Config.ConfigError> = Layer.effect(
    ShellConfig,
    Effect.gen(function* () {
      const external = yield* Config.option(Config.String("SPORTAL_HUB_URL"))
      const port = yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400))

      if (Option.isSome(external))
        return ShellConfig.of({ hubUrl: external.value, embeddedHub: Option.none() })
      // `defaultApp` is set only when Electron runs an app from a folder (`electron .`), never once it is installed.
      const installed = process.defaultApp !== true
      const embeddedHub = installed
        ? {
            script: join(process.resourcesPath, "hub", "hub.mjs"),
            webRoot: join(process.resourcesPath, "web"),
            port
          }
        : {
            // This file is bundled into apps/desktop/out/main.
            script: join(import.meta.dirname, "../../../hub/dist/hub.mjs"),
            webRoot: join(import.meta.dirname, "../../../web/dist"),
            port
          }
      return ShellConfig.of({ hubUrl: `http://127.0.0.1:${port}`, embeddedHub: Option.some(embeddedHub) })
    })
  )
}
