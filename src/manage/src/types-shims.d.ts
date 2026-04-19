// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

declare module "simplify-geojson" {
  import { type GeoJSON } from "geojson";

  export default function simplify<G extends GeoJSON>(feature: G, tolerance?: number): G;
}
