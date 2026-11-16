import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { collectFailures, main } from "./check-prod-runtime-resolution.mjs";

function makeFixture(missing) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "resolution-noexec-"));
  const marker = path.join(root, "executed.marker");
  const trap = (name) => `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)});\nthrow new Error(${JSON.stringify(`executed ${name}`)});\n`;
  const files = {
    "server/dist/index.js": `import "@myrmidon/trap";\n${trap("server")}`,
    "node_modules/@myrmidon/trap/package.json": JSON.stringify({ name: "@myrmidon/trap", type: "module", exports: "./dist/index.js" }),
    "node_modules/@myrmidon/trap/dist/index.js": `import "./helper.js";\n${trap("package")}`,
    "node_modules/@myrmidon/trap/dist/helper.js": `${missing ? 'import "@myrmidon/missing";\n' : ""}${trap("helper")}`,
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return { root, marker, files };
}

function assertUntouched({ root, marker, files }) {
  assert.equal(fs.existsSync(marker), false, "audited JavaScript must not run");
  for (const [name, contents] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(root, name)), Buffer.from(contents), name);
  }
}

describe("runtime resolution does not execute JavaScript", () => {
  for (const missing of [true, false]) {
    it(missing ? "reports the missing helper import without executing the graph" : "accepts a clean graph without executing it", () => {
      const fixture = makeFixture(missing);
      const { root } = fixture;
      try {
        const failures = collectFailures(path.join(root, "server/dist"));
        assertUntouched(fixture);
        assert.deepEqual(failures, missing ? [{
          file: path.join(root, "node_modules/@myrmidon/trap/dist/helper.js"),
          line: 1,
          specifier: "@myrmidon/missing",
          reason: "пакет не найден в node_modules",
          packageName: "@myrmidon/missing",
        }] : []);

        const output = [];
        const log = { log: (line) => output.push(["log", line]), error: (line) => output.push(["error", line]) };
        const code = main(["--dist", "server/dist"], log, root);
        assertUntouched(fixture);
        assert.equal(code, missing ? 1 : 0);
        assert.deepEqual(output, missing ? [
          ["error", "node_modules/@myrmidon/trap/dist/helper.js:1 @myrmidon/missing → пакет не найден в node_modules"],
          ["error", "1 сбой в 1 пакете"],
        ] : [["log", "0 сбоев в 0 пакетах"]]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
