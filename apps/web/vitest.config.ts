import { fileURLToPath } from "node:url"
import { defineProject } from "vitest/config"

export default defineProject({
  // The `@/` alias, for tests of modules that import a design primitive.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { name: "web" }
})
