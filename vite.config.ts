import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";

export default defineConfig({
  plugins: [react(), svgr()],
  server: {
    port: 3003,
    host: true,
    proxy: {
      "/api": {
        target: process.env.BASE_URL || "http://server:3005",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "build",
    sourcemap: false
  },
  test: {
    environment: "jsdom",
    include: ["src/client/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["src/client/test-setup.ts"]
  }
});
