import { Config, Context, Effect, Layer } from "effect"

/** Every setting the desktop shell reads from its environment, decoded once at startup. */
export class ShellConfig extends Context.Service<ShellConfig, { readonly hubUrl: string }>()(
  "sportal/desktop/ShellConfig"
) {
  /** SPORTAL_HUB_URL, default http://127.0.0.1:4400. */
  static readonly layer: Layer.Layer<ShellConfig, Config.ConfigError> = Layer.effect(
    ShellConfig,
    Effect.gen(function* () {
      const hubUrl = yield* Config.String("SPORTAL_HUB_URL").pipe(Config.withDefault("http://127.0.0.1:4400"))

      return ShellConfig.of({ hubUrl })
    })
  )
}
