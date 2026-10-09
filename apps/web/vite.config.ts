import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  // When the panel is served under a path (ARVOO_PANEL_PATH=/panel), the build
  // must use the same base so asset URLs resolve. Default "/" for local dev.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@arvoo/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:4001",
        changeOrigin: true,
      },
      // The panel asks the API for /health directly (the login screen shows
      // real reachability). Nginx proxies it in production; without the same
      // rule here, dev returned index.html and the UI claimed a database
      // problem that did not exist.
      "/health": {
        target: "http://localhost:4001",
        changeOrigin: true,
      },
    },
  },
  // `npm run preview` serves the production build with the same /api proxy, so
  // the artifact that Nginx will serve can be verified locally end to end.
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:4001",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:4001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // No source maps in the panel build: the artifact is served from the same
    // origin as the control plane, and a .map file would hand over the full
    // source of the admin UI (spec §35). Debug with a local dev build instead.
    sourcemap: false,
  },
});
