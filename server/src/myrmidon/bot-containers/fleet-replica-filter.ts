// server/src/myrmidon/bot-containers/fleet-replica-filter.ts
//
// myrmidon(fleet-site audit): leaves the secret profile files out of a bot snapshot before the
// board keeps it (fleet-replica-store.ts).
//
// A snapshot is the site-agent's stream: a tar inside a zstd frame of raw blocks, ending with a
// manifest entry (tools/fleetd writeSnapshot) that the restore recomputes and checks. The datadir of
// a bot holds files the profile compiler writes again on every apply (hermes/.env with the API keys,
// hermes/config.yaml with MCP headers; see profile-files.ts). A restore is always followed by an
// apply (fleet-move-service.ts: restore, then writeProfile, then start), so the stored copy of those
// files is not needed, and it would keep the secrets on the board's disk after the card has rotated
// them. The filter drops them.
//
// What it does, in one pass and without keeping the archive in memory:
//   1. decodes the zstd frame (raw blocks only, like fleetd writes and restores them);
//   2. walks the tar entries, drops the ones at or below an excluded path, copies the others byte
//      for byte (their PAX records, headers, data and padding);
//   3. recomputes the manifest over the entries it kept (entry count, bytes, SHA-256 in archive
//      order, the same hash fleetd uses) and writes it as the new last entry;
//   4. frames the result as a zstd frame of raw blocks.
// The manifest that came with the snapshot is checked against everything that was read, so a
// stream that broke off or was altered on the way is refused here, not stored.
//
// It fails closed. Anything it does not fully understand — a compressed zstd block, a PAX record
// that could change a size or a name in a way the restore reads differently, a hard link, a device,
// a name that leaves the datadir — ends the stream with an error and nothing is stored. The checks
// are deliberately narrower than what tar allows: this is a security control, so a header the
// restore side could read differently from this side must not pass.

import { createHash } from "node:crypto";
import path from "node:path";
import { PROFILE_SECRET_FILE_PATHS } from "./profile-files.js";
import { buildUstarArchive } from "./ustar.js";

export class ReplicaFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicaFilterError";
  }
}

export interface ReplicaFilterOptions {
  /**
   * Paths relative to the datadir that are left out. An entry named by one of them, or below it,
   * is dropped. Defaults to the secret files of the profile compiler.
   */
  excludePaths?: readonly string[];
  /** Called once with what the pass did, after the manifest has been written. */
  onReport?: (report: ReplicaFilterReport) => void;
}

export interface ReplicaFilterReport {
  /** Entries in the snapshot as it came (without its manifest). */
  entries: number;
  /** Entries left in the stored snapshot. */
  keptEntries: number;
  /** The cleaned names of the dropped entries, in archive order. */
  excludedPaths: string[];
}

const BLOCK = 512;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Frame header descriptor 0x00 and window descriptor 0x50 (1 MB window): what fleetd writes. */
const ZSTD_FRAME_HEADER = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50]);
const ZSTD_MAX_BLOCK = 128 * 1024;
const MANIFEST_NAME = ".fleetd-snapshot-manifest";
const MAX_MANIFEST_BYTES = 1 << 20;
const MAX_PAX_BYTES = 64 * 1024;
const DATA_CHUNK = 64 * 1024;
/** The uid and gid fleetd gives every entry (the bot user in the container). */
const BOT_UID = 10001;
/** The PAX records Go's archive/tar writes for a datadir, or ignores when it reads them. */
const PAX_KEYS = new Set(["path", "linkpath", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"]);

const TYPE_FILE = 0x30; // '0'
const TYPE_SYMLINK = 0x32; // '2'
const TYPE_DIR = 0x35; // '5'
const TYPE_PAX = 0x78; // 'x'

/* ------------------------------------------------------------------ byte source */

function asBuffer(value: Uint8Array | string): Buffer {
  return typeof value === "string" ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Pull-based reader over an async iterable of chunks. */
class Reader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private received = 0;
  private readonly iterator: AsyncIterator<Uint8Array | string>;

  constructor(source: AsyncIterable<Uint8Array | string>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    const chunk = asBuffer(next.value);
    this.received += chunk.length;
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    return true;
  }

  private take(count: number): Buffer {
    if (count === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length >= count) {
      this.buffered -= count;
      if (first.length === count) {
        this.chunks.shift();
        return first;
      }
      this.chunks[0] = first.subarray(count);
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.chunks[0];
      const used = Math.min(chunk.length, count - offset);
      chunk.copy(out, offset, 0, used);
      offset += used;
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    this.buffered -= count;
    return out;
  }

  /** Exactly `count` bytes; the stream ending first is an error. */
  async exact(count: number, what: string): Promise<Buffer> {
    while (this.buffered < count) {
      if (!(await this.pull())) {
        throw new ReplicaFilterError(this.received === 0 ? "replica stream was empty" : `snapshot ended inside ${what}`);
      }
    }
    return this.take(count);
  }

  /** At least one and at most `max` bytes, or null at the end of the stream. */
  async some(max: number): Promise<Buffer | null> {
    while (this.buffered === 0) {
      if (!(await this.pull())) return null;
    }
    return this.take(Math.min(max, this.buffered));
  }
}

/* ------------------------------------------------------------------ zstd */

/** The tar bytes inside a zstd frame of raw blocks. Anything else is an error. */
async function* decodeRawZstd(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<Buffer> {
  const reader = new Reader(source);
  const magic = await reader.exact(4, "the zstd magic number");
  if (!magic.equals(ZSTD_MAGIC)) throw new ReplicaFilterError("snapshot is not a zstd frame");
  const descriptor = (await reader.exact(1, "the zstd frame header"))[0];
  const singleSegment = (descriptor & 0x20) !== 0;
  if ((descriptor & 0x08) !== 0) throw new ReplicaFilterError("zstd frame header has a reserved bit set");
  if ((descriptor & 0x04) !== 0) throw new ReplicaFilterError("zstd frame carries a content checksum, which the snapshot format does not");
  if ((descriptor & 0x03) !== 0) throw new ReplicaFilterError("zstd frame uses a dictionary, which the snapshot format does not");
  if (!singleSegment) await reader.exact(1, "the zstd window descriptor");
  const contentSizeBytes = singleSegment ? [1, 2, 4, 8][descriptor >> 6] : [0, 2, 4, 8][descriptor >> 6];
  if (contentSizeBytes > 0) await reader.exact(contentSizeBytes, "the zstd content size");

  for (;;) {
    const header = await reader.exact(3, "a zstd block header");
    const value = header[0] | (header[1] << 8) | (header[2] << 16);
    const last = (value & 1) === 1;
    const type = (value >> 1) & 3;
    const size = value >>> 3;
    if (type !== 0) {
      throw new ReplicaFilterError(
        "snapshot uses a compressed zstd block; the secret filter reads raw blocks only (what fleetd writes), so nothing is stored",
      );
    }
    if (size > ZSTD_MAX_BLOCK) throw new ReplicaFilterError("zstd block is larger than 128 KiB");
    let remaining = size;
    while (remaining > 0) {
      const chunk = await reader.some(remaining);
      if (chunk === null) throw new ReplicaFilterError("snapshot ended inside a zstd block");
      remaining -= chunk.length;
      yield chunk;
    }
    if (last) break;
  }
  if ((await reader.some(1)) !== null) throw new ReplicaFilterError("data after the end of the zstd frame");
}

/** Frames bytes as a zstd frame of raw blocks, byte for byte what fleetd's writer produces. */
class RawZstdEncoder {
  private started = false;
  private parts: Buffer[] = [];
  private length = 0;

  *push(data: Buffer): Generator<Buffer> {
    if (!this.started) {
      this.started = true;
      yield ZSTD_FRAME_HEADER;
    }
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(ZSTD_MAX_BLOCK - this.length, data.length - offset);
      this.parts.push(data.subarray(offset, offset + take));
      this.length += take;
      offset += take;
      if (this.length === ZSTD_MAX_BLOCK) yield this.block(false);
    }
  }

  *finish(): Generator<Buffer> {
    if (!this.started) {
      this.started = true;
      yield ZSTD_FRAME_HEADER;
    }
    yield this.block(true);
  }

  private block(last: boolean): Buffer {
    const header = (last ? 1 : 0) | (this.length << 3);
    const out = Buffer.concat([Buffer.from([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]), ...this.parts]);
    this.parts = [];
    this.length = 0;
    return out;
  }
}

/* ------------------------------------------------------------------ manifest */

interface Manifest {
  version: number;
  entries: number;
  bytes: number;
  sha256: string;
}

/** The hash fleetd's manifestHasher computes: entry lines and file contents, in archive order. */
class ManifestHasher {
  private readonly hash = createHash("sha256");
  private entries = 0;
  private bytes = 0;

  entry(kind: "f" | "d" | "l", name: string, size: number, link: string): void {
    // Names are latin1 strings here (one char per byte), so the hash sees the original bytes.
    this.hash.update(Buffer.from(`${kind}\0${name}\0${size}\0${link}\0`, "latin1"));
    this.entries += 1;
    this.bytes += size;
  }

  update(data: Buffer): void {
    this.hash.update(data);
  }

  manifest(): Manifest {
    return { version: 1, entries: this.entries, bytes: this.bytes, sha256: this.hash.copy().digest("hex") };
  }
}

function parseManifest(body: Buffer): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ReplicaFilterError("invalid manifest: not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ReplicaFilterError("invalid manifest: not an object");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "bytes,entries,sha256,version") throw new ReplicaFilterError("invalid manifest: unexpected fields");
  const { version, entries, bytes, sha256 } = record;
  if (
    version !== 1 ||
    typeof entries !== "number" ||
    !Number.isSafeInteger(entries) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    typeof sha256 !== "string"
  ) {
    throw new ReplicaFilterError("invalid manifest: bad field values");
  }
  return { version, entries, bytes, sha256 };
}

/* ------------------------------------------------------------------ tar */

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false;
  return true;
}

function roundUp(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function cString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return (end === -1 ? field : field.subarray(0, end)).toString("latin1");
}

/** Octal like Go's parser reads it: spaces and NULs around the digits are padding. Base-256 is refused. */
function octal(block: Buffer, offset: number, length: number, what: string): number {
  if ((block[offset] & 0x80) !== 0) throw new ReplicaFilterError(`unsupported binary number in the tar ${what} field`);
  const text = block.toString("latin1", offset, offset + length).replace(/^[\0 ]+|[\0 ]+$/g, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ReplicaFilterError(`malformed number in the tar ${what} field`);
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new ReplicaFilterError(`the tar ${what} field is too large`);
  return value;
}

function verifyHeader(block: Buffer): void {
  const stored = octal(block, 148, 8, "checksum");
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) throw new ReplicaFilterError("bad tar header checksum");
  if (block.toString("latin1", 257, 263) !== "ustar\0" || block.toString("latin1", 263, 265) !== "00") {
    throw new ReplicaFilterError("tar header is not POSIX ustar");
  }
}

/** PAX records, latin1 so that the byte counts in the record lengths are character counts. */
function parsePax(body: Buffer): Map<string, string> {
  const text = body.toString("latin1");
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) throw new ReplicaFilterError("malformed PAX record");
    const lengthText = text.slice(offset, space);
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new ReplicaFilterError("malformed PAX record length");
    const length = Number(lengthText);
    if (offset + length > text.length) throw new ReplicaFilterError("PAX record runs past its header");
    const record = text.slice(space + 1, offset + length);
    if (!record.endsWith("\n")) throw new ReplicaFilterError("malformed PAX record end");
    const body2 = record.slice(0, -1);
    const equals = body2.indexOf("=");
    if (equals <= 0) throw new ReplicaFilterError("malformed PAX record");
    const key = body2.slice(0, equals);
    const value = body2.slice(equals + 1);
    if (!PAX_KEYS.has(key)) throw new ReplicaFilterError(`unsupported PAX record "${key}"`);
    if ((key === "path" || key === "linkpath") && value === "") throw new ReplicaFilterError(`empty PAX ${key}`);
    records.set(key, value);
    offset += length;
  }
  return records;
}

/**
 * The name the restore side works with: filepath.Clean of the header name. A name that is
 * absolute, climbs out of the datadir or contains a NUL ends the pass (the restore refuses it too).
 */
function cleanName(raw: string): string {
  if (raw.includes("\0")) throw new ReplicaFilterError("tar entry name contains a NUL");
  const cleaned = path.posix.normalize(raw).replace(/\/+$/, "");
  if (cleaned === "" || cleaned === "." || cleaned === ".." || cleaned.startsWith("../") || cleaned.startsWith("/")) {
    throw new ReplicaFilterError("tar entry name leaves the datadir");
  }
  return cleaned;
}

function isExcluded(name: string, excludes: readonly string[]): boolean {
  return excludes.some((excluded) => name === excluded || name.startsWith(`${excluded}/`));
}

/* ------------------------------------------------------------------ the filter */

async function* filterTar(
  source: AsyncIterable<Uint8Array | string>,
  excludes: readonly string[],
  report: ReplicaFilterReport,
): AsyncGenerator<Buffer> {
  const tar = new Reader(decodeRawZstd(source));
  const everything = new ManifestHasher();
  const kept = new ManifestHasher();
  let original: Manifest | null = null;
  let pax: { records: Map<string, string>; raw: Buffer[] } | null = null;

  for (;;) {
    const header = await tar.exact(BLOCK, "a tar header");
    if (isZeroBlock(header)) {
      if (pax !== null) throw new ReplicaFilterError("PAX header without an entry after it");
      if (!isZeroBlock(await tar.exact(BLOCK, "the end of the tar archive"))) {
        throw new ReplicaFilterError("tar archive does not end with two zero blocks");
      }
      for (let rest = await tar.some(DATA_CHUNK); rest !== null; rest = await tar.some(DATA_CHUNK)) {
        if (!isZeroBlock(rest)) throw new ReplicaFilterError("data after the end of the tar archive");
      }
      break;
    }
    if (original !== null) throw new ReplicaFilterError("invalid archive: entries after the manifest");
    verifyHeader(header);
    const typeflag = header[156];
    const size = octal(header, 124, 12, "size");

    if (typeflag === TYPE_PAX) {
      if (pax !== null) throw new ReplicaFilterError("two PAX headers in a row");
      if (size === 0 || size > MAX_PAX_BYTES) throw new ReplicaFilterError("PAX header has an unusable size");
      const body = await tar.exact(roundUp(size), "a PAX header");
      pax = { records: parsePax(body.subarray(0, size)), raw: [header, body] };
      continue;
    }

    let kind: "f" | "d" | "l";
    if (typeflag === TYPE_FILE) kind = "f";
    else if (typeflag === TYPE_DIR) kind = "d";
    else if (typeflag === TYPE_SYMLINK) kind = "l";
    else throw new ReplicaFilterError(`unsupported tar entry type ${typeflag}`);
    // The restore skips no data after a directory or a link whatever their size field says; refuse
    // a size there so that both sides agree where the next header starts.
    if (kind !== "f" && size !== 0) throw new ReplicaFilterError("directory or link entry with a size");

    const prefix = cString(header, 345, 155);
    const rawName = pax?.records.get("path") ?? (prefix === "" ? cString(header, 0, 100) : `${prefix}/${cString(header, 0, 100)}`);
    const link = kind === "l" ? (pax?.records.get("linkpath") ?? cString(header, 157, 100)) : "";

    if (rawName === MANIFEST_NAME) {
      if (kind !== "f" || pax !== null) throw new ReplicaFilterError("invalid manifest entry");
      if (size > MAX_MANIFEST_BYTES) throw new ReplicaFilterError("invalid manifest: too large");
      const body = await tar.exact(roundUp(size), "the manifest");
      original = parseManifest(body.subarray(0, size));
      continue;
    }

    const name = cleanName(rawName);
    if (name === MANIFEST_NAME) throw new ReplicaFilterError("tar entry uses the reserved manifest name");
    everything.entry(kind, name, size, link);
    report.entries += 1;
    const dropped = isExcluded(name, excludes);

    if (!dropped) {
      kept.entry(kind, name, size, link);
      report.keptEntries += 1;
      if (pax !== null) yield* pax.raw;
      yield header;
    } else {
      report.excludedPaths.push(name);
    }
    pax = null;

    if (kind === "f") {
      for (let remaining = size; remaining > 0; ) {
        const chunk = await tar.some(Math.min(remaining, DATA_CHUNK));
        if (chunk === null) throw new ReplicaFilterError("snapshot ended inside a file");
        remaining -= chunk.length;
        everything.update(chunk);
        if (!dropped) {
          kept.update(chunk);
          yield chunk;
        }
      }
      const padding = roundUp(size) - size;
      if (padding > 0) {
        const pad = await tar.exact(padding, "tar padding");
        if (!dropped) yield pad;
      }
    }
  }

  if (original === null) throw new ReplicaFilterError("incomplete snapshot: manifest missing");
  const seen = everything.manifest();
  if (original.entries !== seen.entries || original.bytes !== seen.bytes || original.sha256 !== seen.sha256) {
    throw new ReplicaFilterError(
      `snapshot verification failed: manifest ${original.entries} entries/${original.bytes} bytes, read ${seen.entries} entries/${seen.bytes} bytes`,
    );
  }
  // The new manifest covers what is left; the entry and the end of the archive come from the same ustar writer the profile PUT uses.
  yield buildUstarArchive([
    {
      path: MANIFEST_NAME,
      content: Buffer.from(JSON.stringify(kept.manifest())),
      mode: 0o600,
      uid: BOT_UID,
      gid: BOT_UID,
      mtime: new Date(0),
    },
  ]);
}

/**
 * Filters a snapshot stream: the same snapshot without the entries at or below `excludePaths`,
 * with a manifest that matches what is left. Use it as a stream stage:
 * `pipeline(snapshot, (source) => filterReplicaSnapshot(source), destination)`.
 * Ends with a ReplicaFilterError (nothing valid is produced) when the snapshot is not one it can
 * read and check completely.
 */
export async function* filterReplicaSnapshot(
  source: AsyncIterable<Uint8Array | string>,
  options: ReplicaFilterOptions = {},
): AsyncGenerator<Buffer> {
  const excludes = (options.excludePaths ?? PROFILE_SECRET_FILE_PATHS).map(cleanName);
  const report: ReplicaFilterReport = { entries: 0, keptEntries: 0, excludedPaths: [] };
  const encoder = new RawZstdEncoder();
  for await (const piece of filterTar(source, excludes, report)) yield* encoder.push(piece);
  yield* encoder.finish();
  options.onReport?.(report);
}
