import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn primitives import each other through `@/`; it is the web app's `src/`.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 4401,
    // On the home network too, so other devices can open the UI.
    host: true,
    // In development the Hub runs separately; in production it serves this app itself.
    proxy: { "/api": { target: "http://127.0.0.1:4400", ws: true } }
  }
})
