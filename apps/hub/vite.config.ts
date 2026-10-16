import { defineConfig } from "vite"

// The Hub as one ES module with every dependency inlined, so the desktop app can run it with no node_modules beside it.
export default defineConfig({
  build: {
    ssr: "src/main.ts",
    outDir: "dist",
    target: "node24",
    rolldownOptions: { output: { entryFileNames: "hub.mjs" } }
  },
  ssr: { noExternal: true, target: "node" }
})
