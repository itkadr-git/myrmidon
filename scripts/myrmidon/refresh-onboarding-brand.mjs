#!/usr/bin/env node
// Run against the instance's companies directory after deploying the CI image.
// Dry-run by default; only known stock phrases in persisted bundles are changed.
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
if (rootIndex < 0 || !args[rootIndex + 1] || args[rootIndex + 1].startsWith("--")) {
  throw new Error("Usage: node scripts/myrmidon/refresh-onboarding-brand.mjs --root <instance companies directory> [--apply]");
}
const root = path.resolve(args[rootIndex + 1]);
const replacements = [
  ["You are an agent at Paperclip company.", "You are an agent at a company running on Myrmidon."],
  ["the Paperclip skill", "the Myrmidon skill"],
  ["Paperclip wake events", "Myrmidon wake events"],
  ["Paperclip may already checkout", "Myrmidon may already checkout"],
];
let changed = 0;
async function walk(dir, segments = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(target, [...segments, entry.name]);
    if (!entry.isFile() || !["AGENTS.md", "HEARTBEAT.md"].includes(entry.name)) continue;
    // Limit edits to <company>/agents/<agent>/instructions/<stock entry file>.
    if (segments.length !== 4 || segments[1] !== "agents" || segments[3] !== "instructions") continue;
    const before = await fs.readFile(target, "utf8");
    let after = before;
    for (const [oldText, newText] of replacements) after = after.replaceAll(oldText, newText);
    if (after === before) continue;
    changed++;
    if (args.includes("--apply")) {
      // Never overwrite an earlier backup; reruns remain safe after partial rollout.
      const backupDir = path.join(path.dirname(dir), "onboarding-brand-backup");
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(target, path.join(backupDir, entry.name), fs.constants.COPYFILE_EXCL).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      await fs.writeFile(target, after, "utf8");
    }
    console.log(`${args.includes("--apply") ? "updated" : "would update"}: ${path.relative(root, target)}`);
  }
}
await walk(root);
console.log(`${changed} bundle file(s) ${args.includes("--apply") ? "updated" : "would change"}`);
