import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4401,
    // In development the Hub runs separately; in production it serves this app itself.
    proxy: { "/api": "http://127.0.0.1:4400" }
  }
})
