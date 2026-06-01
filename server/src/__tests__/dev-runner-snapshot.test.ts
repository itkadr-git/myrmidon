import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectWatchedSnapshot,
  diffSnapshots,
  readSignature,
} from "../../../scripts/dev-runner-snapshot.mjs";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function createSnapshotOptions(root: string) {
  return {
    repoRoot: root,
    watchedDirectories: [path.join(root, "server")],
    watchedFiles: [path.join(root, "package.json")],
    ignoredDirectoryNames: new Set(["node_modules"]),
    ignoredRelativePaths: new Set([".paperclip/dev-server-status.json"]),
  };
}

describe("dev-runner watched snapshot", () => {
  it("skips files that disappear between directory listing and stat", () => {
    const root = createTempRoot("paperclip-dev-runner-snapshot-file-race-");
    const serverDir = path.join(root, "server");
    const sourcePath = path.join(serverDir, "index.ts");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(sourcePath, "console.log('boot');\n", "utf8");

    const fileSystem = {
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      statSync(target: fs.PathLike, options?: fs.StatOptions) {
        if (target === sourcePath) {
          fs.rmSync(sourcePath, { force: true });
        }
        return fs.statSync(target, options);
      },
    };

    expect(() => collectWatchedSnapshot({ ...createSnapshotOptions(root), fileSystem })).not.toThrow();
    expect(collectWatchedSnapshot(createSnapshotOptions(root)).has("server/index.ts")).toBe(false);
  });

  it("skips directories that disappear before they can be read", () => {
    const root = createTempRoot("paperclip-dev-runner-snapshot-dir-race-");
    const serverDir = path.join(root, "server");
    const routesDir = path.join(serverDir, "routes");
    fs.mkdirSync(routesDir, { recursive: true });
    fs.writeFileSync(path.join(routesDir, "health.ts"), "export const ok = true;\n", "utf8");

    const fileSystem = {
      existsSync: fs.existsSync,
      readdirSync(target: fs.PathLike, options?: fs.ObjectEncodingOptions & { withFileTypes: true }) {
        if (target === routesDir) {
          fs.rmSync(routesDir, { recursive: true, force: true });
        }
        return fs.readdirSync(target, options);
      },
      statSync: fs.statSync,
    };

    expect(() => collectWatchedSnapshot({ ...createSnapshotOptions(root), fileSystem })).not.toThrow();
    expect(collectWatchedSnapshot(createSnapshotOptions(root)).has("server/routes/health.ts")).toBe(false);
  });

  it("returns null for missing file signatures and reports deleted paths in diffs", () => {
    const root = createTempRoot("paperclip-dev-runner-snapshot-diff-");
    const missingPath = path.join(root, "server", "deleted.ts");

    expect(readSignature(missingPath)).toBeNull();
    expect(diffSnapshots(new Map([["server/deleted.ts", "1:1"]]), new Map())).toEqual(["server/deleted.ts"]);
  });
});
