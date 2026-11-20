import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scanModuleBoundaries } from "../../check-module-boundaries.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), "cache/scratch");

test("scans only production TypeScript in deterministic path order", (t) => {
  mkdirSync(scratch, { recursive: true });
  const serverSrc = mkdtempSync(join(scratch, "module-source-discovery-"));
  t.after(() => rmSync(serverSrc, { recursive: true, force: true }));
  const modulesRoot = join(serverSrc, "modules");
  const domain = "modules/sample/domain";
  const included = ["a.ts", "b.tsx", "nested/c.ts", "nested/d.tsx"];
  const excluded = [
    "e.test.ts", "f.test.tsx", "g.spec.ts", "h.spec.tsx", "i.d.ts",
    "j.js", "k.mjs", "node_modules/l.ts", "node_modules/nested/m.tsx",
    "dist/n.ts", "dist/nested/o.tsx", "nested/node_modules/p.ts", "nested/dist/q.tsx",
  ];
  const paths = [...included, ...excluded].map((name) => `${domain}/${name}`).sort().reverse();
  for (const path of paths) {
    const file = join(serverSrc, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'import "node:fs";\n');
  }

  const expected = included.map((name) => ({
    file: relative(repoRoot, join(serverSrc, domain, name)).split(sep).join("/"),
    layer: "domain",
    specifier: "node:fs",
    reason: "domain cannot import Node.js runtime modules",
  }));
  const first = scanModuleBoundaries({ serverSrc, modulesRoot });
  assert.deepEqual(first, expected);
  assert.deepEqual(scanModuleBoundaries({ serverSrc, modulesRoot }), first);
});
