// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

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
      },
      // OG meta-tag HTML served to social crawlers. In prod the CloudFront
      // spa-rewrite function rewrites /projects/:id → /og/projects/:id for bot
      // User-Agents; in dev there's no CloudFront, so hit /og/projects/:id
      // directly to inspect the HTML. xfwd preserves the original host/proto
      // via X-Forwarded-* so the SPA refresh URL points back at localhost.
      "/og": {
        target: process.env.BASE_URL || "http://server:3005",
        changeOrigin: true,
        xfwd: true
      },
      // Thumbnails live in a public-read S3 bucket. In prod the same-origin
      // /thumbnails/ path is served by CloudFront; in dev we proxy directly
      // to S3 so <img> tags resolve without needing CloudFront deployed.
      // Keys in the bucket are flat (<uuid>.png), so strip the /thumbnails/
      // prefix on the way through.
      "/thumbnails": {
        target:
          process.env.THUMBNAILS_ORIGIN ||
          "https://districtbuilder-production-thumbnails.s3.us-east-1.amazonaws.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/thumbnails/, "")
      }
    }
  },
  define: {
    global: "globalThis"
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
