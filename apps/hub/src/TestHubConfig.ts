import { NodePath } from "@effect/platform-node"
import { ConfigProvider, Layer } from "effect"
import { HubConfig } from "./HubConfig.ts"

/**
 * HubConfig for a test, read from exactly these variables over a fan's `home`, and nothing from the machine
 * running the test.
 */
export function withEnv(env: Record<string, string>) {
  return HubConfig.layer.pipe(Layer.provide(inEnv({ ...home, ...env }, NodePath.layer)))
}

/** A fan's home folder on every OS, so the default data directory resolves without the test machine's own. */
export const home = { HOME: "/home/fan", USERPROFILE: "C:\\Users\\fan" }

/** Exactly these variables as the configuration, beside `path`, and nothing from the machine running the test. */
export function inEnv(env: Record<string, string>, path: typeof NodePath.layer) {
  return Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), path)
}
