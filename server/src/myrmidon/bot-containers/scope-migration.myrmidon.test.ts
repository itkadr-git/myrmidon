// myrmidon(BOT-DISK-F): the host-side move of a bot's directories between layouts,
// on an in-memory host: moves, conflicts that refuse everything, rollback.

import { describe, expect, it } from "vitest";
import type { HostPathState, ScopeLayout } from "@paperclipai/shared";
import { scopeMigrator, ScopeMigrationRefused, type ScopeMigrationHost } from "./scope-migration.js";

const ROOTS = { volumeRoot: "/v", scopeRoot: "/v/.scopes" };
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHARED: ScopeLayout = { kind: "shared", dirName: "caste-x" };
const ISOLATED: ScopeLayout = { kind: "isolated" };

/** A tiny tree: path -> number of entries ("dir" with content) or 0 (empty dir); "file" for a non-directory. */
function memoryHost(tree: Record<string, "dir" | "empty" | "file">, failOn?: (op: string, path: string) => boolean) {
  const log: string[] = [];
  const entries = new Map(Object.entries(tree));
  const host: ScopeMigrationHost = {
    async state(path): Promise<HostPathState> {
      const kind = entries.get(path);
      if (!kind) return "absent";
      return kind === "file" ? "other" : kind === "empty" ? "empty-dir" : "dir";
    },
    async mkdir(path) {
      if (failOn?.("mkdir", path)) throw new Error("mkdir failed");
      entries.set(path, "empty");
      log.push(`mkdir ${path}`);
    },
    async rename(from, to) {
      if (failOn?.("rename", `${from}->${to}`)) throw new Error("EXDEV");
      const kind = entries.get(from);
      if (!kind) throw new Error("ENOENT");
      entries.delete(from);
      entries.set(to, kind);
      log.push(`mv ${from} ${to}`);
    },
    async rmdirEmpty(path) {
      entries.delete(path);
      log.push(`rmdir ${path}`);
    },
  };
  return { host, entries, log };
}

describe("scopeMigrator", () => {
  const isolatedTree = {
    "/v": "dir" as const,
    [`/v/${KEY}`]: "dir" as const,
    [`/v/${KEY}/hermes`]: "dir" as const,
    [`/v/${KEY}/workspace`]: "dir" as const,
    [`/v/${KEY}/scratch`]: "empty" as const,
  };

  it("moves the three directories into the instance and never deletes", async () => {
    const { host, entries, log } = memoryHost(isolatedTree);
    const migrator = scopeMigrator(ROOTS, host);
    await migrator.check({ botKey: KEY, from: ISOLATED, to: SHARED });
    await migrator.run({ botKey: KEY, from: ISOLATED, to: SHARED });
    expect(entries.has(`/v/.scopes/caste-x/${KEY}/hermes`)).toBe(true);
    expect(entries.has(`/v/${KEY}/hermes`)).toBe(false);
    expect(log.filter((line) => line.startsWith("rmdir"))).toEqual([]);
    expect(log.filter((line) => line.startsWith("mv"))).toHaveLength(3);
  });

  it("is idempotent after an interrupted run: a second run finds the directories already there", async () => {
    const { host } = memoryHost(isolatedTree);
    const migrator = scopeMigrator(ROOTS, host);
    await migrator.run({ botKey: KEY, from: ISOLATED, to: SHARED });
    await expect(migrator.run({ botKey: KEY, from: ISOLATED, to: SHARED })).resolves.toBeUndefined();
  });

  it("refuses on a conflict and changes nothing", async () => {
    const { host, log } = memoryHost({ ...isolatedTree, [`/v/.scopes/caste-x/${KEY}/hermes`]: "dir" });
    const migrator = scopeMigrator(ROOTS, host);
    await expect(migrator.check({ botKey: KEY, from: ISOLATED, to: SHARED })).rejects.toBeInstanceOf(ScopeMigrationRefused);
    await expect(migrator.run({ botKey: KEY, from: ISOLATED, to: SHARED })).rejects.toMatchObject({
      conflicts: [{ path: `/v/.scopes/caste-x/${KEY}/hermes` }],
    });
    expect(log).toEqual([]);
  });

  it("a failing step undoes the ones before it", async () => {
    const { host, entries } = memoryHost(isolatedTree, (op, path) => op === "rename" && path.includes("/scratch"));
    const migrator = scopeMigrator(ROOTS, host);
    await expect(migrator.run({ botKey: KEY, from: ISOLATED, to: SHARED })).rejects.toThrow("EXDEV");
    expect(entries.has(`/v/${KEY}/hermes`)).toBe(true);
    expect(entries.has(`/v/${KEY}/workspace`)).toBe(true);
    expect(entries.has(`/v/.scopes/caste-x/${KEY}/hermes`)).toBe(false);
  });

  it("refuses when the board cannot see the volume root", async () => {
    const { host } = memoryHost({});
    await expect(scopeMigrator(ROOTS, host).check({ botKey: KEY, from: ISOLATED, to: SHARED })).rejects.toThrow(/cannot see/);
  });

  it("moves between two instances without touching either's other members", async () => {
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { host, entries } = memoryHost({
      "/v": "dir",
      "/v/.scopes": "dir",
      "/v/.scopes/caste-x": "dir",
      [`/v/.scopes/caste-x/${KEY}`]: "dir",
      [`/v/.scopes/caste-x/${KEY}/hermes`]: "dir",
      [`/v/.scopes/caste-x/${KEY}/workspace`]: "dir",
      [`/v/.scopes/caste-x/${KEY}/scratch`]: "dir",
      [`/v/.scopes/caste-x/${other}`]: "dir",
      [`/v/.scopes/caste-x/${other}/hermes`]: "dir",
    });
    await scopeMigrator(ROOTS, host).run({ botKey: KEY, from: SHARED, to: { kind: "shared", dirName: "project-y" } });
    expect(entries.has(`/v/.scopes/project-y/${KEY}/hermes`)).toBe(true);
    expect(entries.has(`/v/.scopes/caste-x/${other}/hermes`)).toBe(true);
  });
});
