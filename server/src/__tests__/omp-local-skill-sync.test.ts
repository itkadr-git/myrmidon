import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOmpSkills,
  syncOmpSkills,
} from "@myrmidonai/adapter-omp-local/server";

// myrmidon(OMP-LOCAL): targeted skill sync tests for omp_local

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("omp local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/myrmidon";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults and installs the operational Paperclip skill in the OMP skills home", async () => {
    const home = await makeTempDir("paperclip-omp-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "omp_local",
      config: {
        env: {
          HOME: home,
        },
      },
    } as const;

    const before = await listOmpSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(paperclipKey);
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("missing");

    const after = await syncOmpSkills(ctx, [paperclipKey]);
    expect(after.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".omp", "agent", "skills", "myrmidon"))).isSymbolicLink()).toBe(true);
  });
});
