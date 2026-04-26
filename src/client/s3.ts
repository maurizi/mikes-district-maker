// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import axios from "axios";

import {
  type TypedArrays,
  type GeoUnitHierarchy,
  type HttpsURI,
  type IStaticFile,
  type IStaticMetadata
} from "../shared/entities";
import { type AdjacencyData } from "../shared/boundary";
import { type StaticProjectData, type WorkerProjectData } from "./types";

const s3Axios = axios.create();

// Region artifacts are served same-origin through CloudFront in prod and via
// Vite proxies in dev — the keyPrefix is the path component (e.g.
// "regions/US/PA/2026-04-26T.../") and bucket resolution is infra concern.
// Use `self.location` rather than `window.location` so this also works when
// imported from a Web Worker (workers have `self`/`location` but no `window`).
function staticDataUri(keyPrefix: string, fileName: string): HttpsURI {
  return new URL(`${keyPrefix}${fileName}`, self.location.origin).href;
}

export async function fetchStaticMetadata(keyPrefix: string): Promise<IStaticMetadata> {
  return new Promise((resolve, reject) => {
    s3Axios
      .get(staticDataUri(keyPrefix, "static-metadata.json"))
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

export async function fetchGeoUnitHierarchy(keyPrefix: string): Promise<GeoUnitHierarchy> {
  return new Promise((resolve, reject) => {
    s3Axios
      .get(staticDataUri(keyPrefix, "geounit-hierarchy.json"))
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

async function fetchStaticFiles(
  keyPrefix: string,
  files: readonly IStaticFile[]
): Promise<TypedArrays> {
  const requests = files.map(fileMeta =>
    s3Axios.get(staticDataUri(keyPrefix, fileMeta.fileName), {
      responseType: "arraybuffer"
    })
  );

  return new Promise((resolve, reject) => {
    axios
      .all(requests)
      .then(response =>
        resolve(
          response.map((res, ind) => {
            const bpe = files[ind].bytesPerElement;
            const unsigned = files[ind].unsigned;
            const typedArrayConstructor =
              unsigned || unsigned === undefined
                ? bpe === 1
                  ? Uint8Array
                  : bpe === 2
                    ? Uint16Array
                    : Uint32Array
                : bpe === 1
                  ? Int8Array
                  : bpe === 2
                    ? Int16Array
                    : Int32Array;

            const typedArray = new typedArrayConstructor(res.data);
            return typedArray;
          })
        )
      )
      .catch(error => reject(error.message));
  });
}

export async function fetchAllStaticData(keyPrefix: string): Promise<StaticProjectData> {
  return fetchStaticMetadata(keyPrefix)
    .then(staticMetadata =>
      Promise.all([
        Promise.resolve(staticMetadata),
        fetchGeoUnitHierarchy(keyPrefix),
        fetchStaticFiles(keyPrefix, staticMetadata.geoLevels)
      ])
    )
    .then(([staticMetadata, geoUnitHierarchy, staticGeoLevels]) => ({
      staticMetadata,
      geoUnitHierarchy,
      staticGeoLevels
    }));
}

export async function fetchBlockIds(keyPrefix: string): Promise<readonly string[]> {
  const response = await s3Axios.get<string[]>(staticDataUri(keyPrefix, "block-ids.json"));
  return response.data;
}

export async function fetchAdjacencyData(keyPrefix: string): Promise<AdjacencyData> {
  const [adjResp, offsetsResp, coordsResp, transformResp] = await Promise.all([
    s3Axios.get(staticDataUri(keyPrefix, "adjacency.bin"), { responseType: "arraybuffer" }),
    s3Axios.get(staticDataUri(keyPrefix, "arc-offsets.bin"), { responseType: "arraybuffer" }),
    s3Axios.get(staticDataUri(keyPrefix, "arc-coords.bin"), { responseType: "arraybuffer" }),
    s3Axios.get(staticDataUri(keyPrefix, "transform.json"))
  ]);
  return {
    adjacency: new Int32Array(adjResp.data),
    arcOffsets: new Uint32Array(offsetsResp.data),
    arcCoords: coordsResp.data,
    transform: transformResp.data
  };
}

export async function fetchWorkerStaticData(
  keyPrefix: string,
  staticMetadata: IStaticMetadata
): Promise<WorkerProjectData> {
  return Promise.all([
    fetchGeoUnitHierarchy(keyPrefix),
    fetchStaticFiles(keyPrefix, staticMetadata.demographics),
    staticMetadata.voting && fetchStaticFiles(keyPrefix, staticMetadata.voting)
  ]).then(([geoUnitHierarchy, staticDemographics, staticVotingData]) => ({
    geoUnitHierarchy,
    staticDemographics,
    staticVotingData
  }));
}
