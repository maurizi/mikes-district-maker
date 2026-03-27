import axios from "axios";

import {
  TypedArrays,
  GeoUnitHierarchy,
  HttpsURI,
  IStaticFile,
  IStaticMetadata,
  S3URI
} from "../shared/entities";
import { AdjacencyData } from "./boundary";
import { StaticProjectData, WorkerProjectData } from "./types";

const s3Axios = axios.create();

export function s3ToHttps(path: S3URI): HttpsURI {
  const uri = new URL(path);
  return new URL(uri.pathname, `https://${uri.hostname}.s3.amazonaws.com`).href;
}

function staticDataUri(path: S3URI, fileName: string): HttpsURI {
  return new URL(fileName, s3ToHttps(path)).href;
}

export async function fetchStaticMetadata(path: S3URI): Promise<IStaticMetadata> {
  return new Promise((resolve, reject) => {
    s3Axios
      .get(staticDataUri(path, "static-metadata.json"))
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

async function fetchGeoUnitHierarchy(path: S3URI): Promise<GeoUnitHierarchy> {
  return new Promise((resolve, reject) => {
    s3Axios
      .get(staticDataUri(path, "geounit-hierarchy.json"))
      .then(response => resolve(response.data))
      .catch(error => reject(error.message));
  });
}

async function fetchStaticFiles(path: S3URI, files: readonly IStaticFile[]): Promise<TypedArrays> {
  const requests = files.map(fileMeta =>
    s3Axios.get(staticDataUri(path, fileMeta.fileName), {
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

export async function fetchAllStaticData(path: S3URI): Promise<StaticProjectData> {
  return fetchStaticMetadata(path)
    .then(staticMetadata =>
      Promise.all([
        Promise.resolve(staticMetadata),
        fetchGeoUnitHierarchy(path),
        fetchStaticFiles(path, staticMetadata.geoLevels)
      ])
    )
    .then(([staticMetadata, geoUnitHierarchy, staticGeoLevels]) => ({
      staticMetadata,
      geoUnitHierarchy,
      staticGeoLevels
    }));
}

export async function fetchBlockIds(path: S3URI): Promise<readonly string[]> {
  const response = await s3Axios.get(staticDataUri(path, "block-ids.json"));
  return response.data;
}

export async function fetchAdjacencyData(path: S3URI): Promise<AdjacencyData> {
  const [adjResp, offsetsResp, coordsResp, transformResp] = await Promise.all([
    s3Axios.get(staticDataUri(path, "adjacency.bin"), { responseType: "arraybuffer" }),
    s3Axios.get(staticDataUri(path, "arc-offsets.bin"), { responseType: "arraybuffer" }),
    s3Axios.get(staticDataUri(path, "arc-coords.bin"), { responseType: "arraybuffer" }),
    s3Axios.get(staticDataUri(path, "transform.json"))
  ]);
  return {
    adjacency: new Int32Array(adjResp.data),
    arcOffsets: new Uint32Array(offsetsResp.data),
    arcCoords: coordsResp.data,
    transform: transformResp.data
  };
}

export async function fetchWorkerStaticData(
  path: S3URI,
  staticMetadata: IStaticMetadata
): Promise<WorkerProjectData> {
  return Promise.all([
    fetchGeoUnitHierarchy(path),
    fetchStaticFiles(path, staticMetadata.demographics),
    staticMetadata.voting && fetchStaticFiles(path, staticMetadata.voting)
  ]).then(([geoUnitHierarchy, staticDemographics, staticVotingData]) => ({
    geoUnitHierarchy,
    staticDemographics,
    staticVotingData
  }));
}
