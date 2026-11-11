// myrmidon(fleet-site audit): the secret filter of the replica store.
//
// Snapshots here are built by fleet-replica-snapshot-fixtures.ts, which writes the format of
// tools/fleetd (tar in a zstd frame of raw blocks, a manifest as the last entry) without using the
// filter. Everything is placeholder data: fake keys and fake paths.

import { describe, expect, it } from "vitest";
import { ReplicaFilterError, filterReplicaSnapshot, type ReplicaFilterReport } from "./fleet-replica-filter.js";
import {
  MANIFEST_NAME,
  makeSnapshot,
  makeTar,
  paxEntry,
  readSnapshot,
  tarHeader,
  zstdRaw,
  type SnapshotEntry,
} from "./fleet-replica-snapshot-fixtures.js";

const SECRET = "API_SERVER_KEY=fake-secret-key-0001\n";

const BASE: SnapshotEntry[] = [
  { path: "hermes", type: "directory" },
  { path: "hermes/.env", content: SECRET },
  { path: "hermes/config.yaml", content: "mcp_servers:\n  board:\n    headers:\n      Authorization: Bearer fake-header-token\n" },
  { path: "hermes/hindsight", type: "directory" },
  { path: "hermes/hindsight/config.json", content: "{}\n" },
  { path: "hermes/state.db", content: `SQLite format 3\0${"x".repeat(1000)}` },
  { path: "workspace", type: "directory" },
  { path: "workspace/notes.md", content: "notes\n" },
  { path: "workspace/link", type: "symlink", link: "notes.md" },
];

async function* chunked(buffer: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

async function run(
  snapshot: Buffer,
  options: { chunk?: number; excludePaths?: readonly string[] } = {},
): Promise<{ out: Buffer; report: ReplicaFilterReport | null }> {
  let report: ReplicaFilterReport | null = null;
  const parts: Buffer[] = [];
  for await (const piece of filterReplicaSnapshot(chunked(snapshot, options.chunk ?? 1 << 20), {
    ...(options.excludePaths ? { excludePaths: options.excludePaths } : {}),
    onReport: (r) => {
      report = r;
    },
  })) {
    parts.push(piece);
  }
  return { out: Buffer.concat(parts), report };
}

async function rejection(snapshot: Buffer, pattern: RegExp): Promise<void> {
  let error: unknown = null;
  try {
    await run(snapshot, { chunk: 777 });
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ReplicaFilterError);
  expect((error as Error).message).toMatch(pattern);
}

function names(snapshot: Buffer): string[] {
  return readSnapshot(snapshot).entries.map((e) => e.name);
}

/** Block sizes of a zstd frame of raw blocks, with the checks a decoder makes. */
function blockSizes(frame: Buffer): number[] {
  expect(frame.subarray(0, 6).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50]))).toBe(true);
  const sizes: number[] = [];
  let offset = 6;
  for (;;) {
    const value = frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16);
    expect((value >> 1) & 3).toBe(0);
    const size = value >>> 3;
    sizes.push(size);
    offset += 3 + size;
    if (value & 1) break;
  }
  expect(offset).toBe(frame.length);
  return sizes;
}

function withChecksum(block: Buffer): Buffer {
  block.write("        ", 148, "latin1");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += block[i];
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

describe("replica filter: what it leaves out", () => {
  it("drops hermes/.env and hermes/config.yaml, keeps everything else as it was, and rewrites the manifest", async () => {
    const input = makeSnapshot(BASE);
    expect(readSnapshot(input).manifestOk).toBe(true);
    const { out, report } = await run(input);

    const result = readSnapshot(out);
    expect(result.manifestOk).toBe(true);
    expect(result.entries.map((e) => e.name)).toEqual([
      "hermes",
      "hermes/hindsight",
      "hermes/hindsight/config.json",
      "hermes/state.db",
      "workspace",
      "workspace/notes.md",
      "workspace/link",
    ]);
    expect(result.entries.find((e) => e.name === "hermes/state.db")?.content).toBe(`SQLite format 3\0${"x".repeat(1000)}`);
    expect(result.entries.find((e) => e.name === "workspace/link")).toMatchObject({ type: "symlink", link: "notes.md" });
    expect(result.manifest).toMatchObject({ version: 1, entries: 7 });
    expect(result.manifest?.bytes).toBe(3 + 1016 + 6);
    // the secret bytes are nowhere in what is stored
    expect(out.includes(Buffer.from("fake-secret-key-0001"))).toBe(false);
    expect(out.includes(Buffer.from("fake-header-token"))).toBe(false);
    expect(report).toEqual({ entries: 9, keptEntries: 7, excludedPaths: ["hermes/.env", "hermes/config.yaml"] });
  });

  it("gives the same bytes whatever the chunks of the input are", async () => {
    const input = makeSnapshot(BASE, { blockSize: 1000 });
    const whole = (await run(input)).out;
    for (const chunk of [1, 7, 511, 512, 513, 4096]) {
      expect((await run(input, { chunk })).out.equals(whole)).toBe(true);
    }
  });

  it("copies the entries it keeps byte for byte", async () => {
    // a snapshot without a secret file passes with the same tar bytes in front of the new manifest
    const keep: SnapshotEntry[] = BASE.filter((e) => !/\.env$|config\.yaml$/.test(e.path));
    const input = makeSnapshot(keep);
    const { out, report } = await run(input);
    expect(report?.excludedPaths).toEqual([]);
    expect(readSnapshot(out)).toEqual(readSnapshot(input));
    const dataLength = makeTar(keep, { manifest: "none", endBlocks: 0 }).length;
    const inputTar = Buffer.concat(blockedParts(input));
    const outTar = Buffer.concat(blockedParts(out));
    expect(outTar.subarray(0, dataLength).equals(inputTar.subarray(0, dataLength))).toBe(true);
  });

  it("re-frames big files into blocks of at most 128 KiB, ending with a last block", async () => {
    const big = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));
    const input = makeSnapshot([{ path: "hermes/.env", content: SECRET }, { path: "workspace/big.bin", content: big }], { blockSize: 1000 });
    const { out } = await run(input, { chunk: 5000 });
    const sizes = blockSizes(out);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(128 * 1024);
    expect(sizes.slice(0, -1).every((size) => size === 128 * 1024)).toBe(true);
    const result = readSnapshot(out);
    expect(result.manifestOk).toBe(true);
    expect(Buffer.from(result.entries[0].content, "latin1").equals(big)).toBe(true);
  });

  it("keeps names that only look like the secret paths", async () => {
    const lookAlikes = [
      "hermes/.env.bak",
      "hermes/.environment",
      "hermes/.ENV",
      "hermes/config.yaml.old",
      "xhermes/.env",
      "hermes/sub/.env",
      "workspace/hermes/.env",
      "hermes/config.yml",
    ];
    const { out, report } = await run(makeSnapshot(lookAlikes.map((path) => ({ path, content: "x" }))));
    expect(names(out)).toEqual(lookAlikes);
    expect(report?.excludedPaths).toEqual([]);
    expect(readSnapshot(out).manifestOk).toBe(true);
  });

  it("drops a directory, a link or a file at the path, and everything below it", async () => {
    const input = makeSnapshot([
      { path: "hermes", type: "directory" },
      { path: "hermes/.env", type: "directory" },
      { path: "hermes/.env/inner", content: "x" },
      { path: "hermes/config.yaml", type: "symlink", link: "elsewhere" },
      { path: "hermes/kept", content: "y" },
    ]);
    const { out, report } = await run(input);
    expect(names(out)).toEqual(["hermes", "hermes/kept"]);
    expect(report?.excludedPaths).toEqual(["hermes/.env", "hermes/.env/inner", "hermes/config.yaml"]);
    expect(readSnapshot(out).manifestOk).toBe(true);
  });

  it("reads the name the way the restore does: cleaned, joined with the prefix, or taken from the PAX path", async () => {
    const input = makeSnapshot([
      { path: "./hermes/.env", content: "a" },
      { path: "hermes//.env", content: "b" },
      { path: "hermes/x/../.env", content: "c" },
      { path: "hermes/./config.yaml", content: "d" },
      { path: ".env", prefix: "hermes", content: "e" },
      { path: "decoy.txt", pax: { path: "hermes/.env" }, content: "f" },
      { path: "hermes/.env", pax: { path: "workspace/kept-by-pax.txt" }, content: "g" },
      { path: "placeholder", pax: { path: `workspace/${"long-".repeat(30)}name.txt` }, content: "h" },
      { path: "workspace/after.txt", content: "i" },
    ]);
    const { out, report } = await run(input, { chunk: 100 });
    expect(names(out)).toEqual(["workspace/kept-by-pax.txt", `workspace/${"long-".repeat(30)}name.txt`, "workspace/after.txt"]);
    expect(report?.excludedPaths).toEqual(["hermes/.env", "hermes/.env", "hermes/.env", "hermes/config.yaml", "hermes/.env", "hermes/.env"]);
    const result = readSnapshot(out);
    expect(result.manifestOk).toBe(true);
    expect(result.entries.map((e) => e.content)).toEqual(["g", "h", "i"]);
  });

  it("takes the paths to leave out from the options", async () => {
    const { out } = await run(makeSnapshot(BASE), { excludePaths: ["workspace/notes.md", "./hermes/state.db/"] });
    expect(names(out)).toEqual([
      "hermes",
      "hermes/.env",
      "hermes/config.yaml",
      "hermes/hindsight",
      "hermes/hindsight/config.json",
      "workspace",
      "workspace/link",
    ]);
    expect(readSnapshot(out).manifestOk).toBe(true);
  });

  it("an empty snapshot passes: only the manifest is left", async () => {
    const { out } = await run(makeSnapshot([]));
    const result = readSnapshot(out);
    expect(result.entries).toEqual([]);
    expect(result.manifest).toMatchObject({ entries: 0, bytes: 0 });
    expect(result.manifestOk).toBe(true);
  });

  it("accepts extra zero blocks at the end of the tar, as tar writers may pad", async () => {
    const { out } = await run(makeSnapshot(BASE, { endBlocks: 20 }));
    expect(readSnapshot(out).manifestOk).toBe(true);
  });
});

/** The decoded tar bytes of a snapshot, as blocks (for the byte comparison above). */
function blockedParts(frame: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 6;
  for (;;) {
    const value = frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16);
    const size = value >>> 3;
    parts.push(frame.subarray(offset + 3, offset + 3 + size));
    offset += 3 + size;
    if (value & 1) return parts;
  }
}

describe("replica filter: what it refuses", () => {
  it("a stream that is not a zstd frame, or is empty", async () => {
    await rejection(Buffer.from("plain text, not a snapshot"), /not a zstd frame/);
    await rejection(makeTar(BASE), /not a zstd frame/);
    await rejection(Buffer.alloc(0), /empty/);
  });

  it("a snapshot that broke off, at any point", async () => {
    const small = makeSnapshot([{ path: "hermes/.env", content: SECRET }, { path: "a.txt", content: "x".repeat(700) }]);
    for (let length = 1; length < small.length; length += 1) {
      await rejection(small.subarray(0, length), /./);
    }
  });

  it("a tar cut short inside a valid zstd frame", async () => {
    const tar = makeTar([{ path: "a.txt", content: "x".repeat(2000) }]);
    await rejection(zstdRaw(tar.subarray(0, 700)), /ended inside/);
    await rejection(zstdRaw(tar.subarray(0, 100)), /ended inside/);
    await rejection(zstdRaw(makeTar([{ path: "a.txt", content: "x" }], { endBlocks: 0 })), /ended inside/);
    await rejection(zstdRaw(makeTar([{ path: "a.txt", content: "x" }], { endBlocks: 1 })), /ended inside/);
  });

  it("data after the zstd frame or after the tar end", async () => {
    await rejection(Buffer.concat([makeSnapshot(BASE), Buffer.from([0])]), /data after the end of the zstd frame/);
    await rejection(zstdRaw(Buffer.concat([makeTar(BASE), Buffer.from("junk")])), /data after the end of the tar archive/);
    await rejection(zstdRaw(Buffer.concat([makeTar(BASE), Buffer.alloc(512, 1)])), /data after the end of the tar archive/);
  });

  it("zstd that the filter cannot read: compressed blocks, a checksum, a dictionary, a reserved bit, a block over 128 KiB", async () => {
    const compressed = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50, 0x05, 0x00, 0x00]);
    await rejection(compressed, /compressed zstd block/);
    const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50, 0x03, 0x00, 0x00]);
    await rejection(rle, /compressed zstd block/);
    await rejection(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x50]), /content checksum/);
    await rejection(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x50]), /dictionary/);
    await rejection(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x08, 0x50]), /reserved bit/);
    const huge = 128 * 1024 + 1;
    const header = 1 | (huge << 3);
    await rejection(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50, header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]), /larger than 128 KiB/);
  });

  it("a missing, a wrong or a malformed manifest", async () => {
    await rejection(makeSnapshot(BASE, { manifest: "none" }), /manifest missing/);
    await rejection(makeSnapshot(BASE, { manifest: "wrong" }), /verification failed/);
    // one byte of a file changed after the manifest was made
    const tampered = makeTar(BASE);
    const at = tampered.indexOf(Buffer.from("notes\n"));
    tampered[at] = 0x4e;
    await rejection(zstdRaw(tampered), /verification failed/);

    const manifestWith = (body: string) =>
      zstdRaw(Buffer.concat([tarHeader({ name: MANIFEST_NAME, typeflag: "0", size: body.length }), Buffer.from(body.padEnd(512, "\0")), Buffer.alloc(1024)]));
    await rejection(manifestWith("not json"), /invalid manifest: not JSON/);
    await rejection(manifestWith("[]"), /invalid manifest: not an object/);
    await rejection(manifestWith(JSON.stringify({ version: 1, entries: 0, bytes: 0, sha256: "", extra: 1 })), /unexpected fields/);
    await rejection(manifestWith(JSON.stringify({ version: 2, entries: 0, bytes: 0, sha256: "" })), /bad field values/);
    await rejection(manifestWith(JSON.stringify({ version: 1, entries: "0", bytes: 0, sha256: "" })), /bad field values/);
  });

  it("entries after the manifest, a manifest that is not a file, and the manifest name used by another entry", async () => {
    await rejection(makeSnapshot(BASE, { afterManifest: [{ path: "late.txt", content: "x" }] }), /entries after the manifest/);
    await rejection(makeSnapshot([{ path: MANIFEST_NAME, type: "directory" }], { manifest: "none" }), /invalid manifest entry/);
    await rejection(makeSnapshot([{ path: `./${MANIFEST_NAME}`, content: "{}" }], { manifest: "none" }), /reserved manifest name/);
    await rejection(makeSnapshot([{ path: "decoy", pax: { path: MANIFEST_NAME }, content: "{}" }], { manifest: "none" }), /invalid manifest entry/);
  });

  it("entry types the restore does not take: hard links, devices, GNU long names, global PAX headers, sparse files", async () => {
    for (const typeflag of ["1", "3", "4", "6", "7", "g", "L", "K", "S", "\0"]) {
      await rejection(makeSnapshot([{ path: "x", typeflag }], { manifest: "none" }), /unsupported tar entry type/);
    }
  });

  it("PAX records that could change what the restore reads", async () => {
    await rejection(makeSnapshot([{ path: "x", pax: { size: "0" }, content: "abc" }]), /unsupported PAX record "size"/);
    await rejection(makeSnapshot([{ path: "x", pax: { "GNU.sparse.name": "y" }, content: "abc" }]), /unsupported PAX record/);
    await rejection(makeSnapshot([{ path: "x", pax: { "SCHILY.xattr.user.k": "v" }, content: "abc" }]), /unsupported PAX record/);
    await rejection(makeSnapshot([{ path: "x", pax: { path: "" }, content: "abc" }]), /empty PAX path/);
    await rejection(makeSnapshot([{ path: "x", pax: { path: "a\0b" }, content: "abc" }]), /NUL/);
    await rejection(
      zstdRaw(Buffer.concat([paxEntry({ path: "a" }), paxEntry({ path: "b" }), tarHeader({ name: "c", typeflag: "0", size: 0 }), Buffer.alloc(1024)])),
      /two PAX headers/,
    );
    await rejection(zstdRaw(Buffer.concat([paxEntry({ path: "a" }), Buffer.alloc(1024)])), /PAX header without an entry/);
  });

  it("PAX records that are not well formed", async () => {
    const raw = (body: string) =>
      zstdRaw(
        Buffer.concat([
          tarHeader({ name: "PaxHeaders.0/x", typeflag: "x", size: body.length }),
          Buffer.from(body.padEnd(512, "\0")),
          tarHeader({ name: "c", typeflag: "0", size: 0 }),
          Buffer.alloc(1024),
        ]),
      );
    await rejection(raw("no-length path=a\n"), /malformed PAX record length/);
    await rejection(raw("8 path=a"), /malformed PAX record end/);
    await rejection(raw("99 path=a\n"), /runs past/);
    await rejection(raw("12 patha\nxxxx"), /malformed PAX record/);
    await rejection(raw("0 path=a\n"), /malformed PAX record length/);
  });

  it("names that leave the datadir", async () => {
    for (const name of ["../etc/x", "a/../../b", "/abs/path", "..", ".", "a/.."]) {
      await rejection(makeSnapshot([{ path: name, content: "x" }]), /leaves the datadir/);
    }
  });

  it("a directory or a link that states a size, which the restore side would skip differently", async () => {
    await rejection(makeSnapshot([{ path: "d", type: "directory", sizeField: 5 }, { path: "hermes/.env", content: "x" }]), /directory or link entry with a size/);
    await rejection(makeSnapshot([{ path: "l", type: "symlink", link: "t", sizeField: 512 }]), /directory or link entry with a size/);
  });

  it("headers with a bad checksum, a binary number or another format", async () => {
    const entry = (block: Buffer) => zstdRaw(Buffer.concat([block, Buffer.alloc(1024)]));
    await rejection(entry(tarHeader({ name: "a", typeflag: "0", size: 0, corrupt: true })), /bad tar header checksum/);
    const binary = tarHeader({ name: "a", typeflag: "0", size: 0 });
    binary[124] = 0x80;
    await rejection(entry(withChecksum(binary)), /unsupported binary number/);
    const garbage = tarHeader({ name: "a", typeflag: "0", size: 0 });
    garbage.write("12x45", 124, "latin1");
    await rejection(entry(withChecksum(garbage)), /malformed number/);
    await rejection(entry(tarHeader({ name: "a", typeflag: "0", size: 0, magic: "ustar  \0" })), /not POSIX ustar/);
    await rejection(entry(tarHeader({ name: "a", typeflag: "0", size: 0, magic: "\0\0\0\0\0\0\0\0" })), /not POSIX ustar/);
  });

  it("is an Error the store can report, and never yields a complete frame for a bad snapshot", async () => {
    const parts: Buffer[] = [];
    let thrown: unknown = null;
    try {
      for await (const piece of filterReplicaSnapshot(chunked(makeSnapshot(BASE, { manifest: "wrong" }), 4096))) parts.push(piece);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReplicaFilterError);
    // whatever was yielded before the check is a frame without its last block: it does not decode
    const partial = Buffer.concat(parts);
    expect(() => readSnapshot(partial)).toThrow();
  });
});
