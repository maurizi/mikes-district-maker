// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { decode, encode } from "../../shared/compress";

describe("shared/compress", () => {
  it("roundtrips a small object", async () => {
    const v = { hello: "world", n: 42, arr: [1, 2, 3] };
    const enc = await encode(v);
    expect(enc.startsWith("gz1:")).toBe(true);
    expect(await decode(enc)).toEqual(v);
  });

  it("roundtrips a 1000-district DistrictProperties-shaped array", async () => {
    const districts = Array.from({ length: 1000 }, (_, i) => ({
      contiguity: "contiguous",
      compactness: 0.5 + (i % 100) / 1000,
      demographics: {
        population: 100000 + i,
        white: 50000 + i,
        black: 25000 + i,
        asian: 10000 + i,
        hispanic: 15000 + i
      },
      voting: { democrat20: 50000 + i, republican20: 49000 + i, other20: 1000 + i }
    }));
    const enc = await encode(districts);
    expect(enc.length).toBeLessThan(1_040_000);
    const dec = await decode<typeof districts>(enc);
    expect(dec).toEqual(districts);
  });

  it("decode passes through legacy raw JSON unchanged", async () => {
    const raw = JSON.stringify([0, 1, 2, [0, 0, 1]]);
    expect(await decode(raw)).toEqual([0, 1, 2, [0, 0, 1]]);
  });

  it("encode is deterministic (same input -> same output)", async () => {
    const v = { a: [1, 2, 3], b: "anything" };
    expect(await encode(v)).toEqual(await encode(v));
  });
});
