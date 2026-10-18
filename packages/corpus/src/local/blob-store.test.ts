// myrmidon(CORPUS-A): LocalBlobStore on a temp directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "./blob-store.js";

describe("LocalBlobStore", () => {
  let rootDir: string;
  let store: LocalBlobStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "corpus-blob-test-"));
    store = new LocalBlobStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("puts, stats and gets bytes under a nested key", async () => {
    const data = new TextEncoder().encode("hello corpus");
    const stat = await store.put("company-1/doc-1/report.pdf", data);
    expect(stat).toEqual({ key: "company-1/doc-1/report.pdf", byteSize: data.byteLength });

    const read = await store.get("company-1/doc-1/report.pdf");
    expect(read).not.toBeNull();
    expect(new TextDecoder().decode(read!)).toBe("hello corpus");

    expect(await store.stat("company-1/doc-1/report.pdf")).toEqual(stat);
  });

  it("returns null / false for missing keys", async () => {
    expect(await store.get("nope")).toBeNull();
    expect(await store.stat("nope")).toBeNull();
    expect(await store.delete("nope")).toBe(false);
  });

  it("overwrites an existing key idempotently", async () => {
    await store.put("k", new TextEncoder().encode("v1"));
    await store.put("k", new TextEncoder().encode("v2-longer"));
    expect(new TextDecoder().decode((await store.get("k"))!)).toBe("v2-longer");
  });

  it("deletes an existing key", async () => {
    await store.put("k", new Uint8Array([1, 2, 3]));
    expect(await store.delete("k")).toBe(true);
    expect(await store.get("k")).toBeNull();
  });

  it("rejects keys that escape the store root", async () => {
    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow(/escapes/);
    await expect(store.get("/absolute/path")).rejects.toThrow(/absolute/);
    await expect(store.put("", new Uint8Array([1]))).rejects.toThrow(/empty/);
  });
});
