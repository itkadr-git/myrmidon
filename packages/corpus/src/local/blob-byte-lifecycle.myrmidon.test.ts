import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "./blob-store.js";

describe("LocalBlobStore byte lifecycle", () => {
  let root: string;
  let store: LocalBlobStore;
  const key = "company/document/blob.bin";
  const long = new Uint8Array([0, 255, 17, 0, 128, 255, 42, 99]);
  const short = new Uint8Array([255, 0, 7]);
  const empty = new Uint8Array([]);
  const again = new Uint8Array([0, 255, 1, 2]);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "corpus-byte-lifecycle-"));
    store = new LocalBlobStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectBytes(expected: Uint8Array) {
    expect(await store.get(key)).toEqual(expected);
    expect(await store.stat(key)).toEqual({ key, byteSize: expected.byteLength });
  }

  it("round trips the full binary range in a nested key", async () => {
    expect(await store.put(key, long)).toEqual({ key, byteSize: 8 });
    await expectBytes(long);
  });

  it("truncates a longer binary blob on a shorter overwrite", async () => {
    await store.put(key, long);
    expect(await store.put(key, short)).toEqual({ key, byteSize: 3 });
    await expectBytes(short);
  });

  it("truncates an existing blob to zero bytes", async () => {
    await store.put(key, long);
    expect(await store.put(key, empty)).toEqual({ key, byteSize: 0 });
    await expectBytes(empty);
  });

  it("writes binary bytes after an empty blob", async () => {
    await store.put(key, empty);
    expect(await store.put(key, again)).toEqual({ key, byteSize: 4 });
    await expectBytes(again);
  });

  it("retains the exact bytes through the complete lifecycle", async () => {
    for (const bytes of [long, short, empty, again]) {
      expect(await store.put(key, bytes)).toEqual({ key, byteSize: bytes.byteLength });
      await expectBytes(bytes);
    }
    expect(await store.delete(key)).toBe(true);
    expect(await store.get(key)).toBeNull();
    expect(await store.stat(key)).toBeNull();
    expect(await store.delete(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    expect(await store.stat(key)).toBeNull();
  });

  it("does not change a second key when overwriting the first", async () => {
    const other = "company/document/other.bin";
    await store.put(key, long);
    await store.put(other, again);
    await store.put(key, short);
    await expectBytes(short);
    expect(await store.get(other)).toEqual(again);
    expect(await store.stat(other)).toEqual({ key: other, byteSize: 4 });
  });

  it("does not change a second key when deleting the first", async () => {
    const other = "company/document/other.bin";
    await store.put(key, long);
    await store.put(other, short);
    expect(await store.delete(key)).toBe(true);
    expect(await store.get(other)).toEqual(short);
    expect(await store.stat(other)).toEqual({ key: other, byteSize: 3 });
  });

  it("does not persist mutations to a returned buffer", async () => {
    await store.put(key, long);
    const read = await store.get(key);
    expect(read).not.toBeNull();
    read?.fill(23);
    await expectBytes(long);
  });

  it("returns null and false when the parent is missing", async () => {
    expect(await store.get(key)).toBeNull();
    expect(await store.stat(key)).toBeNull();
    expect(await store.delete(key)).toBe(false);
  });

  it("returns null when stat targets a directory", async () => {
    await mkdir(path.join(root, "company", "document"), { recursive: true });
    expect(await store.stat("company/document")).toBeNull();
  });

  it("replaces equal-length bytes without retaining old contents", async () => {
    await store.put(key, short);
    const replacement = new Uint8Array([0, 255, 0]);
    expect(await store.put(key, replacement)).toEqual({ key, byteSize: 3 });
    await expectBytes(replacement);
  });

  it("recreates a deleted key with exact bytes", async () => {
    await store.put(key, long);
    expect(await store.delete(key)).toBe(true);
    expect(await store.put(key, short)).toEqual({ key, byteSize: 3 });
    await expectBytes(short);
  });
});
