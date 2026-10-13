// myrmidon(CORPUS-A): BlobStore on a local directory (the board's compatible
// file storage until a networked object store is wired in by a later part).
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BlobStat, BlobStore } from "../ports.js";

export class LocalBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  private resolveKey(key: string): string {
    if (key.length === 0) throw new Error("corpus blob: empty key");
    if (path.isAbsolute(key)) throw new Error(`corpus blob: absolute key rejected: ${key}`);
    const resolved = path.resolve(this.rootDir, key);
    const root = path.resolve(this.rootDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`corpus blob: key escapes store root: ${key}`);
    }
    return resolved;
  }

  async put(key: string, data: Uint8Array): Promise<BlobStat> {
    const filePath = this.resolveKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    // O_TRUNC keeps re-uploads idempotent: same key, same resulting bytes.
    const handle = await open(filePath, "w");
    try {
      await handle.write(data);
    } finally {
      await handle.close();
    }
    return { key, byteSize: data.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const data = await readFile(this.resolveKey(key));
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await rm(this.resolveKey(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const info = await stat(this.resolveKey(key));
      if (!info.isFile()) return null;
      return { key, byteSize: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
