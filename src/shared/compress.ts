// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

// Compresses JSON payloads stored in Aurora DSQL `text` columns to fit under
// the per-value 1 MiB cap. Used by `Project.districtsDefinition` and
// `Project.districtProperties`. Format on disk:
//   - `gz1:<base64-of-gzip(JSON.stringify(value))>` for compressed values
//   - any other string is parsed as raw JSON (legacy rows from before this
//     change, plus the deliberately-uncompressed blank `districtsDefinition`
//     server-side default that keeps `findBlankProjectIds`' `[1-9]` regex
//     working — see projects.service.ts)
// CompressionStream is part of the Web Streams API and works in browsers and
// Node 18+, so a single implementation covers both.

const MAGIC = "gz1:";

async function streamThrough(input: Uint8Array, transform: TransformStream): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function bytesToBase64(bytes: Uint8Array): string {
  // Node's Buffer is faster, but btoa(String.fromCharCode(...)) chokes on
  // long arrays via call-stack overflow, so chunk it.
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encode(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  const gz = await streamThrough(utf8Encode(json), new CompressionStream("gzip"));
  return MAGIC + bytesToBase64(gz);
}

export async function decode<T>(stored: string): Promise<T> {
  if (!stored.startsWith(MAGIC)) {
    return JSON.parse(stored) as T;
  }
  const gz = base64ToBytes(stored.slice(MAGIC.length));
  const json = utf8Decode(await streamThrough(gz, new DecompressionStream("gzip")));
  return JSON.parse(json) as T;
}
