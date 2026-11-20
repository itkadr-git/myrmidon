import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanModuleBoundaries } from "../../check-module-boundaries.mjs";

const cases = [
  ["services/consumer.ts", "../modules/beta/index.js", null],
  ["services/consumer.ts", "../modules/beta/index.ts", null],
  ["services/consumer.ts", "../modules/beta/domain/model.js", "beta"],
  ["services/consumer.ts", "../modules/beta/application/run.js", "beta"],
  ["services/consumer.ts", "../modules/beta/index-extra.js", "beta"],
  ["services/consumer.ts", "../modules/beta/nested/index.js", "beta"],
  ["modules/alpha/adapters/consumer.ts", "../../beta/index.js", null],
  ["modules/alpha/adapters/consumer.ts", "../../beta/index.ts", null],
  ["modules/alpha/adapters/consumer.ts", "../../beta/domain/model.js", "beta"],
  ["modules/alpha/adapters/consumer.ts", "../../beta/application/run.js", "beta"],
  ["modules/alpha/adapters/consumer.ts", "../../beta/index-extra.js", "beta"],
  ["modules/alpha/adapters/consumer.ts", "../../beta/nested/index.js", "beta"],
  ["modules/alpha/adapters/consumer.ts", "../../beta/nested/../index.js", null],
  ["services/consumer.ts", "../modules/beta/nested/../domain/model.js", "beta"],
  ["modules/beta/adapters/consumer.ts", "../domain/model.js", null],
  ["modules/beta/adapters/consumer.ts", "../../beta-extra/domain/model.js", "beta-extra"],
  ["modules/beta-extra/adapters/consumer.ts", "../../beta/domain/model.js", "beta"],
  ["services/consumer.ts", "../modules/beta-extra/index.js", null],
];

for (const [source, specifier, targetModule] of cases) {
  test(`${source} importing ${specifier}`, () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), "cache", "scratch");
    mkdirSync(scratch, { recursive: true });
    const serverSrc = mkdtempSync(join(scratch, "module-public-index-"));
    try {
      const modulesRoot = join(serverSrc, "modules");
      mkdirSync(modulesRoot, { recursive: true });
      const sourceFile = join(serverSrc, source);
      mkdirSync(dirname(sourceFile), { recursive: true });
      writeFileSync(sourceFile, `import "${specifier}";\n`);
      const violations = scanModuleBoundaries({ serverSrc, modulesRoot });
      assert.equal(violations.length, targetModule ? 1 : 0);
      if (targetModule) {
        assert.equal(violations[0].specifier, specifier);
        assert.equal(violations[0].layer, source.includes("/adapters/") ? "adapters" : null);
        assert.equal(violations[0].reason, `imports inside module ${targetModule} instead of its index`);
        assert.ok(violations[0].file.endsWith(source));
      }
    } finally {
      rmSync(serverSrc, { recursive: true, force: true });
    }
  });
}
