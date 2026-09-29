import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/ws": { target: "ws://127.0.0.1:5174", ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
