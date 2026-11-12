// server/src/myrmidon/bot-containers/fleet-replica-snapshot-fixtures.ts
//
// Test helpers: builds and reads datadir snapshots in the format of tools/fleetd (writeSnapshot): a
// tar inside a zstd frame of raw blocks, ending with a manifest entry. The builder and the reader
// do not use fleet-replica-filter.ts, so a test can check the filter against an independent
// implementation of the format. Everything here is placeholder data.

import { createHash } from "node:crypto";
import path from "node:path";

export const MANIFEST_NAME = ".fleetd-snapshot-manifest";

export interface SnapshotEntry {
  /** The path as the writer states it; a `pax` path overrides it on the reader's side. */
  path: string;
  type?: "file" | "directory" | "symlink";
  content?: string | Buffer;
  /** Link target of a symlink. */
  link?: string;
  /** PAX records written before the header. */
  pax?: Record<string, string>;
  /** Written into the ustar `prefix` field instead of being part of `path`. */
  prefix?: string;
  /** Replaces the typeflag character (default '0', '5' or '2'). */
  typeflag?: string;
  /** Replaces the size field of the header (the data is still `content`). */
  sizeField?: number;
}

export interface SnapshotOptions {
  /** "ok" (default): a correct manifest. "none": no manifest entry. "wrong": a manifest with another hash. */
  manifest?: "ok" | "none" | "wrong";
  /** Entries after the manifest. */
  afterManifest?: SnapshotEntry[];
  /** Split the zstd frame into blocks of this size (default 128 KiB). */
  blockSize?: number;
  /** Zero blocks at the end of the tar (default 2). */
  endBlocks?: number;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function pad(buffer: Buffer): Buffer {
  const rest = buffer.length % BLOCK;
  return rest === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(BLOCK - rest)]);
}

export function tarHeader(opts: { name: string; typeflag: string; size: number; link?: string; prefix?: string; magic?: string; corrupt?: boolean }): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(opts.name, 0, 100, "latin1");
  block.write(octal(0o644, 8), 100, "latin1");
  block.write(octal(10001, 8), 108, "latin1");
  block.write(octal(10001, 8), 116, "latin1");
  block.write(octal(opts.size, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(opts.typeflag, 156, "latin1");
  block.write(opts.link ?? "", 157, 100, "latin1");
  block.write(opts.magic ?? "ustar\0" + "00", 257, "latin1");
  block.write(opts.prefix ?? "", 345, 155, "latin1");
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += block[i];
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  if (opts.corrupt) block[0] ^= 0xff;
  return block;
}

/** A PAX extended header entry: "<len> <key>=<value>\n" records. */
export function paxEntry(records: Record<string, string>): Buffer {
  const body = Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const rest = Buffer.from(` ${key}=${value}\n`, "latin1");
      let length = rest.length + 1;
      while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
      return Buffer.concat([Buffer.from(String(length), "latin1"), rest]);
    }),
  );
  return Buffer.concat([tarHeader({ name: "PaxHeaders.0/x", typeflag: "x", size: body.length }), pad(body)]);
}

function entryBytes(entry: SnapshotEntry): Buffer {
  const type = entry.type ?? "file";
  const content = type === "file" ? Buffer.from(entry.content ?? "") : Buffer.alloc(0);
  const typeflag = entry.typeflag ?? (type === "directory" ? "5" : type === "symlink" ? "2" : "0");
  const parts: Buffer[] = [];
  if (entry.pax) parts.push(paxEntry(entry.pax));
  parts.push(
    tarHeader({
      name: entry.path,
      typeflag,
      size: entry.sizeField ?? content.length,
      link: entry.link,
      prefix: entry.prefix,
    }),
  );
  parts.push(pad(content));
  return Buffer.concat(parts);
}

/** The name the receiving side works with: Clean of the PAX path or of prefix + name. */
function receivedName(entry: SnapshotEntry): string {
  const raw = entry.pax?.path ?? (entry.prefix ? `${entry.prefix}/${entry.path}` : entry.path);
  return path.posix.normalize(raw).replace(/\/+$/, "");
}

export function manifestOf(entries: SnapshotEntry[]): { version: 1; entries: number; bytes: number; sha256: string } {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const content = type === "file" ? Buffer.from(entry.content ?? "") : Buffer.alloc(0);
    const kind = type === "directory" ? "d" : type === "symlink" ? "l" : "f";
    const link = type === "symlink" ? (entry.pax?.linkpath ?? entry.link ?? "") : "";
    hash.update(Buffer.from(`${kind}\0${receivedName(entry)}\0${content.length}\0${link}\0`, "latin1"));
    hash.update(content);
    bytes += content.length;
  }
  return { version: 1, entries: entries.length, bytes, sha256: hash.digest("hex") };
}

export function zstdRaw(data: Buffer, blockSize = 128 * 1024): Buffer {
  const parts: Buffer[] = [Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50])];
  let offset = 0;
  do {
    const size = Math.min(blockSize, data.length - offset);
    const last = offset + size >= data.length;
    const header = (last ? 1 : 0) | (size << 3);
    parts.push(Buffer.from([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]), data.subarray(offset, offset + size));
    offset += size;
  } while (offset < data.length);
  return Buffer.concat(parts);
}

export function makeTar(entries: SnapshotEntry[], options: SnapshotOptions = {}): Buffer {
  const parts = entries.map(entryBytes);
  if (options.manifest !== "none") {
    const manifest = manifestOf(entries);
    const body = Buffer.from(JSON.stringify(options.manifest === "wrong" ? { ...manifest, sha256: "0".repeat(64) } : manifest));
    parts.push(tarHeader({ name: MANIFEST_NAME, typeflag: "0", size: body.length }), pad(body));
  }
  for (const entry of options.afterManifest ?? []) parts.push(entryBytes(entry));
  parts.push(Buffer.alloc(BLOCK * (options.endBlocks ?? 2)));
  return Buffer.concat(parts);
}

/** A snapshot as fleetd's writeSnapshot makes it. */
export function makeSnapshot(entries: SnapshotEntry[], options: SnapshotOptions = {}): Buffer {
  return zstdRaw(makeTar(entries, options), options.blockSize);
}

export interface ReadSnapshot {
  entries: Array<{ name: string; type: "file" | "directory" | "symlink"; content: string; link: string }>;
  manifest: { version: number; entries: number; bytes: number; sha256: string } | null;
  /** The manifest, recomputed from the entries, matches the one in the archive. */
  manifestOk: boolean;
}

function unzstdRaw(buffer: Buffer): Buffer {
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) throw new Error("not zstd");
  let offset = 6; // magic, descriptor, window
  const parts: Buffer[] = [];
  for (;;) {
    if (offset + 3 > buffer.length) throw new Error("zstd frame is cut short");
    const value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    const size = value >>> 3;
    if (((value >> 1) & 3) !== 0) throw new Error("not a raw block");
    if (offset + 3 + size > buffer.length) throw new Error("zstd frame is cut short");
    parts.push(buffer.subarray(offset + 3, offset + 3 + size));
    offset += 3 + size;
    if (value & 1) break;
  }
  if (offset !== buffer.length) throw new Error("data after the frame");
  return Buffer.concat(parts);
}

/** Reads a snapshot back the way the restore side does (names cleaned), for assertions. */
export function readSnapshot(buffer: Buffer): ReadSnapshot {
  const tar = unzstdRaw(buffer);
  const entries: ReadSnapshot["entries"] = [];
  const asEntries: SnapshotEntry[] = [];
  let manifest: ReadSnapshot["manifest"] = null;
  let pax: Record<string, string> = {};
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) => {
      const field = header.subarray(start, start + length);
      const end = field.indexOf(0);
      return (end === -1 ? field : field.subarray(0, end)).toString("latin1");
    };
    const size = parseInt(header.toString("latin1", 124, 136).replace(/[\0 ]/g, "") || "0", 8);
    const typeflag = String.fromCharCode(header[156]);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + (typeflag === "5" || typeflag === "2" ? 0 : size));
    offset += BLOCK + (typeflag === "5" || typeflag === "2" ? 0 : Math.ceil(size / BLOCK) * BLOCK);
    if (typeflag === "x") {
      pax = {};
      let at = 0;
      const latin = body.toString("latin1");
      while (at < latin.length) {
        const space = latin.indexOf(" ", at);
        const length = Number(latin.slice(at, space));
        const record = latin.slice(space + 1, at + length - 1);
        const eq = record.indexOf("=");
        pax[record.slice(0, eq)] = record.slice(eq + 1);
        at += length;
      }
      continue;
    }
    const prefixField = text(345, 155);
    const rawName = pax.path ?? (prefixField ? `${prefixField}/${text(0, 100)}` : text(0, 100));
    const link = pax.linkpath ?? text(157, 100);
    pax = {};
    if (rawName === MANIFEST_NAME) {
      manifest = JSON.parse(body.toString("utf8"));
      continue;
    }
    const type = typeflag === "5" ? "directory" : typeflag === "2" ? "symlink" : "file";
    const name = path.posix.normalize(rawName).replace(/\/+$/, "");
    entries.push({ name, type, content: type === "file" ? body.toString("latin1") : "", link: type === "symlink" ? link : "" });
    asEntries.push({ path: name, type, content: type === "file" ? Buffer.from(body) : undefined, link: type === "symlink" ? link : undefined });
  }
  const expected = manifestOf(asEntries);
  const manifestOk =
    manifest !== null &&
    manifest.version === expected.version &&
    manifest.entries === expected.entries &&
    manifest.bytes === expected.bytes &&
    manifest.sha256 === expected.sha256;
  return { entries, manifest, manifestOk };
}
