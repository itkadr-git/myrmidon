import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOmpSkillsHome, syncOmpSkills } from "./skills.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

describe("resolveOmpSkillsHome", () => {
  it("uses PI_CODING_AGENT_DIR when present", () => {
    const home = resolveOmpSkillsHome({
      env: { PI_CODING_AGENT_DIR: "/tmp/custom-pi-agent" },
    });
    expect(home).toBe(path.resolve("/tmp/custom-pi-agent/skills"));
  });

  it("uses OMP_CODING_AGENT_DIR when present", () => {
    const home = resolveOmpSkillsHome({
      env: { OMP_CODING_AGENT_DIR: "/tmp/custom-omp-agent" },
    });
    expect(home).toBe(path.resolve("/tmp/custom-omp-agent/skills"));
  });

  it("ignores the workspace agentHome: the omp process reads its own HOME", () => {
    const home = resolveOmpSkillsHome({
      env: { HOME: "/tmp/fake-home" },
      agentHome: "/tmp/workspace-agent-home",
    });
    expect(home).toBe(path.resolve("/tmp/fake-home/.omp/agent/skills"));
  });

  it("falls back to HOME/.omp/agent/skills", () => {
    const home = resolveOmpSkillsHome({
      env: { HOME: "/tmp/fake-home" },
    });
    expect(home).toBe(path.resolve("/tmp/fake-home/.omp/agent/skills"));
  });
});

describe("syncOmpSkills", () => {
  it("creates skills dir and links desired skills", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-test-"));
    cleanupPaths.add(tmpDir);

    const skillsHome = path.join(tmpDir, "skills");
    const fakeSkillSource = path.join(tmpDir, "fake-skill");
    await fs.mkdir(fakeSkillSource, { recursive: true });
    await fs.writeFile(path.join(fakeSkillSource, "SKILL.md"), "# Test Skill", "utf8");

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "omp_local",
      config: {
        env: {
          PI_CODING_AGENT_DIR: tmpDir,
        },
      },
    };

    const snapshot = await syncOmpSkills(ctx, []);
    expect(snapshot.adapterType).toBe("omp_local");
    expect((await fs.stat(skillsHome)).isDirectory()).toBe(true);
  });
});
