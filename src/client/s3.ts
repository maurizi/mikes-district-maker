// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import axios from "axios";

import {
  type TypedArrays,
  type GeoUnitHierarchy,
  type HttpsURI,
  type IStaticMetadata
} from "../shared/entities";
import { type CtopoClient, openContainer } from "cloud-topo";

const s3Axios = axios.create();

// Region artifacts are served same-origin through CloudFront in prod and via
// Vite proxies in dev — the keyPrefix is the path component (e.g.
// "regions/US/PA/2026-04-26T.../") and bucket resolution is infra concern.
// Use `self.location` rather than `window.location` so this also works when
// imported from a Web Worker (workers have `self`/`location` but no `window`).
// regionConfig.version is appended as a `?v=<timestamp>` cache-buster so a
// republished region invalidates CloudFront entries even when keyPrefix is
// reused.
//
// In a production build `__REGION_ARTIFACTS_ORIGIN__` is the empty
// string and we fall through to same-origin CloudFront. In dev Vite
// injects an absolute origin (CloudFront in front of the dev bucket)
// so client fetches skip the Node proxy, which is ~14× slower than
// CloudFront for big Range GETs.
declare const __REGION_ARTIFACTS_ORIGIN__: string;
const REGION_ARTIFACTS_ORIGIN = __REGION_ARTIFACTS_ORIGIN__ || self.location.origin;

export function versionParam(version: Date | string | number): string {
  return new Date(version).getTime().toString();
}

function staticDataUri(
  keyPrefix: string,
  fileName: string,
  version: Date | string | number
): HttpsURI {
  const url = new URL(`${keyPrefix}${fileName}`, REGION_ARTIFACTS_ORIGIN);
  url.searchParams.set("v", versionParam(version));
  return url.href;
}

export async function fetchStaticMetadata(
  keyPrefix: string,
  version: Date | string | number
): Promise<IStaticMetadata> {
  return new Promise((resolve, reject) => {
    s3Axios
      .get(staticDataUri(keyPrefix, "static-metadata.json", version))
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

export async function fetchGeoUnitHierarchy(
  keyPrefix: string,
  version: Date | string | number
): Promise<GeoUnitHierarchy> {
  return new Promise((resolve, reject) => {
    s3Axios
      .get(staticDataUri(keyPrefix, "geounit-hierarchy.json", version))
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

// One CtopoClient per (keyPrefix, version) tuple, shared by every caller
// that needs to read sections out of the container. Caching here means
// the bootstrap Range GET fires once per region per page load, not once
// per consumer; including the version in the cache key means a
// republished region opens a fresh client (matching the URL-level
// cache-buster) instead of reusing stale section offsets.
const clientCache = new Map<string, Promise<CtopoClient>>();

function clientCacheKey(keyPrefix: string, version: Date | string | number): string {
  return `${keyPrefix}@${versionParam(version)}`;
}

// Front-prefetch budget for the open path. 0 disables it entirely —
// open then just awaits the suffix-range footer GET (one RTT) and
// section bytes fetch on demand. Larger values pre-warm the
// byte-range cache with front-loaded sections, but on slow / throttled
// connections the prefetch chunks compete with on-demand boundary
// fetches and end up slowing total time-to-ready. Empirically 0 has
// been fastest for state-sized regions on our test connection.
//
// TODO: move to a region_config column once we have a feel for the
// right per-region tuning.
const FRONT_PREFETCH_BYTES = 0;

export function getCtopoClient(
  keyPrefix: string,
  version: Date | string | number
): Promise<CtopoClient> {
  const key = clientCacheKey(keyPrefix, version);
  let cached = clientCache.get(key);
  if (cached === undefined) {
    cached = openContainer(staticDataUri(keyPrefix, "region.ctopo", version), {
      frontPrefetchBytes: FRONT_PREFETCH_BYTES,
      arcCoordsPrefetchBytes: 5 * 1024,
      maxParallelRanges: 8
    });
    clientCache.set(key, cached);
  }
  return cached;
}

export async function fetchSections(
  client: CtopoClient,
  sectionNames: readonly string[]
): Promise<TypedArrays> {
  // property() is typed as ArrayBufferView in the public surface; the
  // concrete return is always the matching TypedArray (Uint8Array,
  // Float64Array, etc.) since we only call it on numeric-dtype
  // sections here.
  const views = await Promise.all(sectionNames.map(n => client.property(n)));
  return views as unknown as TypedArrays;
}

export async function fetchBlockIds(
  keyPrefix: string,
  version: Date | string | number
): Promise<readonly string[]> {
  const client = await getCtopoClient(keyPrefix, version);
  const baseLayer = client.meta.layers[0].name;
  // The base-layer id property lives in `{baseLayer}/{baseLayer}` —
  // the producer attaches the GEOID under the layer's own name on each
  // geometry (see process-geojson.ts).
  const ids = await client.strings(`${baseLayer}/${baseLayer}`);
  return Array.from(ids);
}
