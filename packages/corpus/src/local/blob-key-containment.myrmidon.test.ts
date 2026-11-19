import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "./blob-store.js";

describe("LocalBlobStore lexical key containment", () => {
  let fixture: string;
  let root: string;
  let store: LocalBlobStore;

  beforeEach(async () => {
    const scratch = process.env.TMPDIR || path.join(homedir(), ".cache", "myrmidon-blob-tests");
    await mkdir(scratch, { recursive: true });
    fixture = await mkdtemp(path.join(scratch, "blob-containment-"));
    root = path.join(fixture, "store");
    await mkdir(root);
    await mkdir(path.join(fixture, "store-sibling"));
    await writeFile(path.join(fixture, "sentinel"), "outside sentinel");
    await writeFile(path.join(fixture, "store-sibling", "sentinel"), "sibling sentinel");
    await writeFile(path.join(root, "inside"), "inside sentinel");
    store = new LocalBlobStore(root);
  });

  afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });

  const operations = {
    put: (store: LocalBlobStore, key: string) => store.put(key, new Uint8Array([9, 8, 7])),
    get: (store: LocalBlobStore, key: string) => store.get(key),
    delete: (store: LocalBlobStore, key: string) => store.delete(key),
    stat: (store: LocalBlobStore, key: string) => store.stat(key),
  };

  const cases: Array<[string, (fixture: string) => string, RegExp]> = [
    ["empty", () => "", /empty key/],
    ["absolute", (fixture) => path.join(fixture, "sentinel"), /absolute key rejected/],
    ["parent traversal", () => "../sentinel", /key escapes store root/],
    ["nested traversal", () => "nested/../../sentinel", /key escapes store root/],
    ["sibling prefix", () => "../store-sibling/sentinel", /key escapes store root/],
  ];

  for (const [operation, invoke] of Object.entries(operations)) {
    for (const [name, key, message] of cases) {
      it(`${operation} rejects ${name} without changing the fixture`, async () => {
        await expect(invoke(store, key(fixture))).rejects.toThrow(message);
        expect(await readdir(fixture)).toEqual(["sentinel", "store", "store-sibling"]);
        expect(await readdir(root)).toEqual(["inside"]);
        expect(await readdir(path.join(fixture, "store-sibling"))).toEqual(["sentinel"]);
        expect(await readFile(path.join(fixture, "sentinel"), "utf8")).toBe("outside sentinel");
        expect(await readFile(path.join(fixture, "store-sibling", "sentinel"), "utf8")).toBe("sibling sentinel");
        expect(await readFile(path.join(root, "inside"), "utf8")).toBe("inside sentinel");
      });
    }
  }

  for (const key of ["nested/deeper/blob", "a/../inside"]) {
    it(`accepts contained key ${key} for all public operations`, async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      expect(await store.put(key, bytes)).toEqual({ key, byteSize: 4 });
      expect(await store.get(key)).toEqual(bytes);
      expect(await store.stat(key)).toEqual({ key, byteSize: 4 });
      expect(await store.delete(key)).toBe(true);
      expect(await store.get(key)).toBeNull();
      expect(await store.stat(key)).toBeNull();
      expect(await store.delete(key)).toBe(false);
    });
  }
});
