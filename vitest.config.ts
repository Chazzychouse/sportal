import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    coverage: {
      provider: "v8",
      reporter: ["json-summary", "text"],
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"]
    }
  }
})
