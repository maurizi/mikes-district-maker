// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import mkcert from "vite-plugin-mkcert";

// Hand the client an absolute CloudFront origin so it skips the slow
// Vite Node proxy (~14× slower for big Range GETs). CloudFront also
// supports multi-range 206 responses from cache, unlike S3 which
// collapses multi-range to a 200 with the full object. A response
// headers policy on the distribution adds CORS headers so cross-origin
// requests from localhost pass preflight. In a production build this
// is the empty string — the client falls back to self.location.origin
// and same-origin CloudFront serves it without preflight.
const DEV_REGION_ARTIFACTS_ORIGIN =
  process.env.REGION_ARTIFACTS_ORIGIN ||
  "https://mikesdistrictmaker.org";

export default defineConfig(({ command }) => ({
  plugins: [react(), svgr(), mkcert()],
  server: {
    port: 3003,
    host: true,
    https: {},
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
      },
      // Per-region static artifacts and the basemap PMTiles. In prod
      // CloudFront fronts these at the same origin; in dev we proxy to
      // CloudFront (which supports multi-range 206 from cache).
      "/regions": {
        target:
          process.env.REGION_ARTIFACTS_ORIGIN ||
          "https://mikesdistrictmaker.org",
        changeOrigin: true
      },
      "/basemap": {
        target:
          process.env.REGION_ARTIFACTS_ORIGIN ||
          "https://mikesdistrictmaker.org",
        changeOrigin: true
      }
    }
  },
  define: {
    global: "globalThis",
    // In dev, hand the client an absolute origin for /regions/* and
    // /basemap/* fetches so they bypass the slow Node proxy. In a
    // production build this is the empty string and the client falls
    // back to self.location.origin (same-origin CloudFront).
    __REGION_ARTIFACTS_ORIGIN__: JSON.stringify(
      command === "serve" ? DEV_REGION_ARTIFACTS_ORIGIN : ""
    )
  },
  build: {
    outDir: "build",
    sourcemap: false
  },
  test: {
    environment: "jsdom",
    include: [
      "src/client/**/*.{test,spec}.{ts,tsx}",
      "src/shared/**/*.{test,spec}.ts"
    ],
    setupFiles: ["src/client/test-setup.ts"]
  }
}));
