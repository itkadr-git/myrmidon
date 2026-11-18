import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));

const fixture = String.raw`
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[1];
const put = (dir, pkg) => {
  const path = join(root, dir, "package.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof pkg === "string" ? pkg : JSON.stringify(pkg));
};
const publicPkg = { name: "@fixture/public", version: "1.2.3", description: "preserved", dependencies: { example: "^1" } };
const serverPkg = { name: "@fixture/server", version: "2.0.0" };
const uiPkg = { name: "@fixture/ui", version: "3.0.0" };
const cliPkg = { name: "@fixture/cli", version: "4.0.0" };
put("packages/group/public", publicPkg);
put("packages/group/private", { name: "private", version: "0", private: true });
put("packages/group/public/nested", { name: "nested-public", version: "0" });
put("packages/group/private/nested", { name: "nested-private", version: "0" });
for (const excluded of ["node_modules", "dist", ".git"]) put("packages/" + excluded + "/bad", "not json");
put("server", serverPkg);
put("ui", uiPkg);
put("cli", cliPkg);
const { discoverPublicPackages } = await import(pathToFileURL(join(root, "scripts/release-package-map.mjs")));
const expected = (dir, pkg) => ({ dir, pkgPath: join(root, dir, "package.json"), name: pkg.name, version: pkg.version, pkg });
const entries = [expected("packages/group/public", publicPkg), expected("server", serverPkg), expected("ui", uiPkg), expected("cli", cliPkg)];
const check = (items) => assert.deepEqual(discoverPublicPackages().sort((a, b) => a.dir.localeCompare(b.dir)), items.sort((a, b) => a.dir.localeCompare(b.dir)));
check([...entries]);
const added = { name: "@fixture/added", version: "5.0.0", extra: ["retained"] };
put("packages/group/added", added);
check([...entries, expected("packages/group/added", added)]);
rmSync(join(root, "packages/group/public"), { recursive: true });
rmSync(join(root, "ui"), { recursive: true });
check([expected("packages/group/added", added), expected("server", serverPkg), expected("cli", cliPkg)]);
`;

test("release discovery respects package boundaries and reads current filesystem", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = realpathSync(mkdtempSync(join(scratch, "myrmidon-discovery-")));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", fixture, root], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
