import { NodePath } from "@effect/platform-node"
import { ConfigProvider, Layer } from "effect"
import { HubConfig } from "./HubConfig.ts"

// A fan's home folder on every OS, so the default data directory resolves without the test machine's own.
const home = { HOME: "/home/fan", USERPROFILE: "C:\\Users\\fan" }

/**
 * HubConfig for a test, read from exactly these variables over a fan's `home`, and nothing from the machine
 * running the test.
 */
export function withEnv(env: Record<string, string>) {
  const variables = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...home, ...env } }))
  return HubConfig.layer.pipe(Layer.provide(Layer.mergeAll(variables, NodePath.layer)))
}
