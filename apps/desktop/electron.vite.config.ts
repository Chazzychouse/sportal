import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@sportal/api", "effect"] },
      rollupOptions: { input: "src/main/main.ts" }
    }
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@sportal/api"] },
      rollupOptions: {
        input: "src/preload/ShellBridge.ts",
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  }
})
