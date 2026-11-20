import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures } from "./check-prod-runtime-resolution.mjs";

function withFixture(run) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-tests");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "relative-closure-")));
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const pkg = (name, files) => {
    const dir = `node_modules/@myrmidon/${name}`;
    write(`${dir}/package.json`, JSON.stringify({ name: `@myrmidon/${name}`, exports: "./dist/index.js" }));
    for (const [file, text] of Object.entries(files)) write(`${dir}/dist/${file}`, text);
  };
  const failures = () => collectFailures(path.join(root, "server/dist")).map((f) => ({
    ...f, file: path.relative(root, f.file),
  }));
  try { run({ write, pkg, failures }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("follows extensionless, mjs and cjs imports to the exact leaf failure", () => withFixture(({ write, pkg, failures }) => {
  write("server/dist/index.js", 'import "@myrmidon/reached";\n');
  pkg("reached", {
    "index.js": 'import "./helper";\n',
    "helper.js": 'import "./deep.mjs";\n',
    "deep.mjs": 'import "./last.cjs";\n',
    "last.cjs": '\nimport "@myrmidon/missing";\n',
  });
  assert.deepEqual(failures(), [{
    file: "node_modules/@myrmidon/reached/dist/last.cjs", line: 2,
    specifier: "@myrmidon/missing", reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing",
  }]);
  pkg("missing", { "index.js": "export {};\n" });
  assert.deepEqual(failures(), []);
}));

test("ignores declarations but reports relative TypeScript from a reached package", () => withFixture(({ write, pkg, failures }) => {
  write("server/dist/index.js", 'import "@myrmidon/reached";\n');
  pkg("reached", {
    "index.js": 'import "./types.d.ts";\nimport "./source.ts";\n',
    "types.d.ts": 'import "@myrmidon/declaration-only";\n',
    "source.ts": 'import "@myrmidon/source-only";\n',
  });
  assert.deepEqual(failures(), [{
    file: "node_modules/@myrmidon/reached/dist/index.js", line: 2,
    specifier: "./source.ts", reason: "относительный импорт .ts", packageName: null,
  }]);
  write("node_modules/@myrmidon/reached/dist/index.js", 'import "./types.d.ts";\n');
  assert.deepEqual(failures(), []);
}));

test("does not scan an unused bad package, but reports it when reached", () => withFixture(({ write, pkg, failures }) => {
  write("server/dist/index.js", 'import "@myrmidon/good";\n');
  pkg("good", { "index.js": "export {};\n" });
  pkg("unused", { "index.js": 'import "@myrmidon/missing";\n' });
  assert.deepEqual(failures(), []);
  write("server/dist/index.js", 'import "@myrmidon/unused";\n');
  assert.deepEqual(failures(), [{
    file: "node_modules/@myrmidon/unused/dist/index.js", line: 1,
    specifier: "@myrmidon/missing", reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing",
  }]);
}));

test("does not report missing relative JavaScript in server or reached package dist", () => withFixture(({ write, pkg, failures }) => {
  write("server/dist/index.js", 'import "./absent.js";\nimport "@myrmidon/reached";\n');
  pkg("reached", { "index.js": 'import "./absent";\nimport "./absent.mjs";\n' });
  assert.deepEqual(failures(), []);
  write("node_modules/@myrmidon/reached/dist/absent.js", 'import "@myrmidon/missing";\n');
  assert.deepEqual(failures(), [{
    file: "node_modules/@myrmidon/reached/dist/absent.js", line: 1,
    specifier: "@myrmidon/missing", reason: "пакет не найден в node_modules", packageName: "@myrmidon/missing",
  }]);
}));
