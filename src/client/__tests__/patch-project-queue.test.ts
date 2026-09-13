// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { describe, expect, it, vi, beforeEach } from "vitest";

// `patchProject` serializes PATCHes per project so concurrent save paths can't
// collide on one row in DSQL (which rejects the loser with OC000). These tests
// drive the queue through axios, the only thing the function touches.

// Hoisted so the mock factory below (which vitest lifts above the imports) can
// close over it.
const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock("axios", () => ({
  default: {
    create: () => ({
      patch,
      defaults: { headers: { common: {} } },
      interceptors: { response: { use: () => undefined } }
    })
  }
}));

import { patchProject } from "../api";

// Resolvable handle so a test can hold a request open and observe ordering.
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Wire shape: the server returns districtsDefinition/districtProperties as
// strings, which formatProject decodes. Plain JSON (no gz1: prefix) takes
// decode's passthrough branch.
const ok = (name: string) => ({
  data: {
    id: "p1",
    name,
    createdDt: "2026-01-01T00:00:00.000Z",
    updatedDt: "2026-01-01T00:00:00.000Z",
    districtsDefinition: "[]"
  }
});

// The queue defers each request by a few microtasks (it awaits the gz1 encode
// before issuing), so poll rather than counting fixed ticks.
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

describe("patchProject serialization", () => {
  beforeEach(() => {
    patch.mockReset();
  });

  it("does not issue a second PATCH for a project while the first is in flight", async () => {
    const first = deferred<unknown>();
    patch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok("second"));

    const a = patchProject("p1", { name: "first" });
    const b = patchProject("p1", { name: "second" });

    await flush();
    // Only the first is in flight; the second must still be queued.
    expect(patch).toHaveBeenCalledTimes(1);

    first.resolve(ok("first"));
    await a;
    await b;
    expect(patch).toHaveBeenCalledTimes(2);
    // Ordering is preserved: the queued call goes out after the first settles.
    expect(patch.mock.calls[0][1]).toEqual({ name: "first" });
    expect(patch.mock.calls[1][1]).toEqual({ name: "second" });
  });

  it("runs PATCHes for different projects in parallel", async () => {
    const held = deferred<unknown>();
    patch.mockReturnValueOnce(held.promise).mockResolvedValueOnce(ok("b"));

    const a = patchProject("p1", { name: "a" });
    const b = patchProject("p2", { name: "b" });

    await b;
    void a;
    expect(patch).toHaveBeenCalledTimes(2);

    held.resolve(ok("a"));
    await a;
  });

  it("keeps draining the queue after a failed PATCH", async () => {
    const failing = deferred<unknown>();
    patch.mockReturnValueOnce(failing.promise).mockResolvedValueOnce(ok("second"));

    const a = patchProject("p1", { name: "first" });
    const b = patchProject("p1", { name: "second" });

    failing.reject({ response: { data: "boom" } });

    await expect(a).rejects.toBe("boom");
    await expect(b).resolves.toMatchObject({ name: "second" });
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("propagates the rejection to the caller that made the failing request", async () => {
    patch.mockRejectedValueOnce({ response: { data: "nope" } });
    await expect(patchProject("p1", { name: "x" })).rejects.toBe("nope");
  });
});
