import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const script = new URL("../../../scripts/myrmidon/refresh-onboarding-brand.mjs", import.meta.url);

it("refreshes persisted stock phrases without rewriting custom text, backups, or external files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "onboarding-brand-"));
  const bundle = path.join(root, "company", "agents", "agent", "instructions");
  try {
    await fs.mkdir(bundle, { recursive: true });
    const file = path.join(bundle, "AGENTS.md");
    const before = "You are an agent at Paperclip company.\nCustom role.\nUse X-Paperclip-Run-Id.\n";
    await fs.writeFile(file, before);
    const external = path.join(root, "AGENTS.md");
    await fs.writeFile(external, before);
    const run = (...flags: string[]) => exec(process.execPath, [script.pathname, "--root", root, ...flags]);
    expect((await run()).stdout).toContain("1 bundle file(s) would change");
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect((await run("--apply")).stdout).toContain("1 bundle file(s) updated");
    expect(await fs.readFile(file, "utf8")).toBe(before.replace(
      "You are an agent at Paperclip company.", "You are an agent at a company running on Myrmidon.",
    ));
    expect(await fs.readFile(path.join(path.dirname(bundle), "onboarding-brand-backup", "AGENTS.md"), "utf8")).toBe(before);
    expect(await fs.readFile(external, "utf8")).toBe(before);
    expect((await run("--apply")).stdout).toContain("0 bundle file(s) updated");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
