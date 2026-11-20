import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures } from "./check-prod-runtime-resolution.mjs";

function fixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "relative-closure-"));
  function write(relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  try {
    const dist = path.join(root, "server/dist");
    write("server/dist/index.js", 'import "@myrmidon/fixture";\n');
    write("node_modules/@myrmidon/fixture/package.json", JSON.stringify({
      name: "@myrmidon/fixture", type: "module", exports: "./dist/index.js",
    }));
    run({ root, dist, write });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const pkg = "node_modules/@myrmidon/fixture/dist";
const missing = 'import "@myrmidon/missing";\n';

for (const [specifier, child] of [
  ["./child.js", "child.js"],
  ["./child.mjs", "child.mjs"],
  ["./child.cjs", "child.cjs"],
  ["./child", "child.js"],
]) {
  test(`reached package follows ${specifier}, but not an unreferenced sibling`, () => fixture(({ root, dist, write }) => {
    const entry = `${pkg}/index.js`;
    const edge = `import "${specifier}";\n`;
    write(entry, edge);
    write(`${pkg}/${child}`, `// child\n${missing}`);
    write(`${pkg}/sibling.js`, 'import "@myrmidon/unreferenced";\n');
    const expected = [{
      file: path.join(root, pkg, child),
      line: 2,
      specifier: "@myrmidon/missing",
      reason: "пакет не найден в node_modules",
      packageName: "@myrmidon/missing",
    }];
    assert.deepEqual(collectFailures(dist), expected);
    write(entry, "export {};\n");
    assert.deepEqual(collectFailures(dist), []);
    write(entry, edge);
    assert.deepEqual(collectFailures(dist), expected);
  }));
}

test("reached package follows a two-hop relative chain and stops when its middle edge is removed", () => fixture(({ root, dist, write }) => {
  write(`${pkg}/index.js`, 'import "./nested/child.js";\n');
  const child = `${pkg}/nested/child.js`;
  const edge = 'import "./grandchild.mjs";\n';
  write(child, edge);
  write(`${pkg}/nested/grandchild.mjs`, missing);
  const expected = [{
    file: path.join(root, pkg, "nested/grandchild.mjs"), line: 1,
    specifier: "@myrmidon/missing", reason: "пакет не найден в node_modules",
    packageName: "@myrmidon/missing",
  }];
  assert.deepEqual(collectFailures(dist), expected);
  write(child, "export {};\n");
  assert.deepEqual(collectFailures(dist), []);
  write(child, edge);
  assert.deepEqual(collectFailures(dist), expected);
}));

test("dist relative imports do not extend the scan outside dist, unlike reached packages", () => fixture(({ root, dist, write }) => {
  write("server/dist/index.js", 'import "../outside.js";\nimport "@myrmidon/fixture";\n');
  write("server/outside.js", missing);
  write(`${pkg}/index.js`, 'import "./child.js";\n');
  write(`${pkg}/child.js`, missing);
  assert.deepEqual(collectFailures(dist), [{
    file: path.join(root, pkg, "child.js"), line: 1, specifier: "@myrmidon/missing",
    reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing",
  }]);
  write(`${pkg}/index.js`, "export {};\n");
  assert.deepEqual(collectFailures(dist), []);
}));

test("missing relative JS is ignored while another reached child is checked", () => fixture(({ root, dist, write }) => {
  write(`${pkg}/index.js`, 'import "./absent.js";\nimport "./child.js";\n');
  write(`${pkg}/child.js`, missing);
  assert.deepEqual(collectFailures(dist), [{
    file: path.join(root, pkg, "child.js"), line: 1, specifier: "@myrmidon/missing",
    reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing",
  }]);
  write(`${pkg}/index.js`, 'import "./absent.js";\n');
  assert.deepEqual(collectFailures(dist), []);
}));
