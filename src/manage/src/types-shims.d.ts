declare module "simplify-geojson" {
  import { type GeoJSON } from "geojson";

  export default function simplify<G extends GeoJSON>(feature: G, tolerance?: number): G;
}
