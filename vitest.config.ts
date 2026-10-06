import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  // The web app's `@/` alias, for tests of modules that import a design primitive.
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  test: { exclude: [...configDefaults.exclude, ".worktrees/**"] }
})
