import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");

test("installs with the temporary manifest before restoring the publish manifest", () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "bundle-phases-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const bin = join(root, "bin");
  const trace = join(root, "npm-trace.jsonl");
  try {
    mkdirSync(source);
    mkdirSync(bin);
    const sourceManifest = {
      name: "fixture-package",
      version: "1.2.3",
      files: ["index.js"],
      bundleDependencies: ["bundled"],
      dependencies: { bundled: "^1.0.0", external: "^2.0.0" },
      optionalDependencies: { optionalExternal: "^3.0.0" },
      peerDependencies: { peerExternal: "^4.0.0" },
      devDependencies: { development: "^5.0.0" },
      publishConfig: { main: "dist/index.js" },
    };
    const sourceBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`;
    writeFileSync(join(source, "package.json"), sourceBytes);
    writeFileSync(join(source, "index.js"), "fixture content\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(bin, "npm"), `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), manifest: JSON.parse(fs.readFileSync("package.json", "utf8")) }) + "\\n");\n`, { mode: 0o755 });

    const child = `import { prepareBundledPackage } from ${JSON.stringify(new URL("./prepare-bundled-package.mjs", import.meta.url).href)};\nprepareBundledPackage(process.argv[1], process.argv[2], { sourceRoot: process.argv[3] });`;
    execFileSync(process.execPath, ["--input-type=module", "-e", child, source, destination, root], {
      env: { PATH: bin, TRACE: trace },
      stdio: "pipe",
    });

    const events = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(events, [{
      argv: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      cwd: destination,
      manifest: {
        name: "fixture-package", version: "1.2.3", files: ["index.js"],
        bundleDependencies: ["bundled"], dependencies: { bundled: "^1.0.0" },
        main: "dist/index.js",
      },
    }]);
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")), {
      name: "fixture-package", version: "1.2.3", files: ["index.js"],
      bundleDependencies: ["bundled"],
      dependencies: { bundled: "^1.0.0", external: "^2.0.0" },
      optionalDependencies: { optionalExternal: "^3.0.0" },
      peerDependencies: { peerExternal: "^4.0.0" },
      devDependencies: { development: "^5.0.0" },
      main: "dist/index.js",
    });
    assert.equal(readFileSync(join(destination, "index.js"), "utf8"), "fixture content\n");
    assert.equal(readFileSync(join(source, "package.json"), "utf8"), sourceBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
