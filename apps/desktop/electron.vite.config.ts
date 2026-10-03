import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@sportal/api", "effect"] },
      rollupOptions: { input: "src/main/main.ts", external: ["electron"] }
    }
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@sportal/api"] },
      rollupOptions: {
        input: "src/preload/ShellBridge.ts",
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  }
})
