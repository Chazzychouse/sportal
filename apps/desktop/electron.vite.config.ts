import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: "src/main/main.ts", external: ["electron"] }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: "src/preload/ShellBridge.ts",
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  }
})
