import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPluginsUnder } from "../../link-plugin-dev-sdk.mjs";

function snapshot(root) {
  const entries = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(root, full);
      if (stat.isSymbolicLink()) entries.push([rel, "link", fs.readlinkSync(full)]);
      else if (stat.isDirectory()) { entries.push([rel, "dir"]); visit(full); }
      else entries.push([rel, "file", fs.readFileSync(full, "utf8")]);
    }
  }
  visit(root);
  return entries;
}

test("discovery prunes symlinks and node_modules without changing the tree", (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "myrmidon-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugins = path.join(root, "plugins");
  const makePackage = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(dir) }));
  };
  const nested = path.join(plugins, "group", "nested");
  const sibling = path.join(plugins, "sibling");
  const external = path.join(root, "external");
  makePackage(nested);
  makePackage(sibling);
  makePackage(external);
  makePackage(path.join(plugins, "node_modules", "hidden"));
  fs.symlinkSync(external, path.join(plugins, "external-link"), "dir");
  fs.symlinkSync(nested, path.join(plugins, "internal-link"), "dir");
  fs.symlinkSync(plugins, path.join(plugins, "group", "cycle"), "dir");
  fs.symlinkSync(external, path.join(plugins, "node_modules", "link"), "dir");
  const before = snapshot(root);
  const expected = [nested, sibling].sort();
  assert.deepEqual(readPluginsUnder(plugins).sort(), expected);
  assert.deepEqual(readPluginsUnder(plugins).sort(), expected);
  assert.deepEqual(snapshot(root), before);
});
