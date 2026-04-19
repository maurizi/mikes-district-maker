// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { GetObjectCommand, type GetObjectCommandInput, type S3Client } from "@aws-sdk/client-s3";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { type S3URI } from "../../../shared/entities";

const CACHE_DIR = process.env.S3_CACHE_DIRECTORY || "/tmp/s3-cache";

export function s3Options(path: S3URI, fileName: string): GetObjectCommandInput {
  const url = new URL(path);
  const pathWithoutLeadingSlash = url.pathname.substring(1);
  const options = { Bucket: url.hostname, Key: `${pathWithoutLeadingSlash}${fileName}` };
  return options;
}

export async function getObject(s3: S3Client, params: GetObjectCommandInput) {
  const result = await s3.send(new GetObjectCommand(params));
  return result;
}

/**
 * Fetch a file from S3, caching to disk on first access.
 * Returns the file contents as a string.
 */
export async function fetchCached(s3: S3Client, s3URI: S3URI, fileName: string): Promise<string> {
  // Derive a cache path from the S3 URI
  const url = new URL(s3URI);
  const cacheKey = url.pathname.substring(1).replace(/\//g, "_");
  const cacheDir = join(CACHE_DIR, cacheKey);
  const cachePath = join(cacheDir, fileName);

  if (existsSync(cachePath)) {
    return readFile(cachePath, { encoding: "utf-8" });
  }

  const params = s3Options(s3URI, fileName);
  const response = await s3.send(new GetObjectCommand(params));
  const body = (await response.Body?.transformToString("utf-8")) ?? "";

  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }
  await writeFile(cachePath, body, "utf-8");

  return body;
}

/**
 * Fetch and parse a JSON file from S3 with disk caching.
 */
export async function fetchCachedJson<T>(s3: S3Client, s3URI: S3URI, fileName: string): Promise<T> {
  const body = await fetchCached(s3, s3URI, fileName);
  return JSON.parse(body) as T;
}

export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
