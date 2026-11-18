import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSharedGuardTrigger, selectTests } from "./select.mjs";

const packages = [{ name: "@myrmidon/server", dir: "server" }];
const routeGuard = "server/src/__tests__/openapi-routes.test.ts";
const appGuard = "server/src/__tests__/app-private-hostname-gate.test.ts";
const pluginGuard = "server/src/myrmidon/app-plugin.myrmidon.test.ts";
const unrelated = "server/src/__tests__/unrelated.test.ts";
const fixtures = [pluginGuard, unrelated, routeGuard, appGuard].map((file) => ({ file, source: "" }));
const sharedResult = {
  wholePackages: [],
  files: [{ package: "@myrmidon/server", files: [appGuard, routeGuard, pluginGuard] }],
};
const emptyResult = { wholePackages: [], files: [] };

describe("shared and route guard trigger matrix", () => {
  for (const trigger of [
    "server/src/app.ts",
    "server/src/index.ts",
    "server/src/myrmidon/app-plugin.ts",
    "docs/myrmidon/FLAGS.md",
    "docs/myrmidon/SETTINGS.md",
    "server/src/myrmidon/app-plugin-extra.ts",
  ]) {
    it(`selects present shared guards for ${trigger}`, () => {
      assert.equal(isSharedGuardTrigger(trigger), true);
      assert.deepEqual(selectTests([trigger], packages, fixtures), sharedResult);
    });
  }

  for (const file of [
    "server/src/myrmidon/app-plugin-extra.tsx",
    "server/src/other/app-plugin-extra.ts",
    "server/src/services/unrelated.ts",
  ]) {
    it(`does not select guards for ${file}`, () => {
      assert.equal(isSharedGuardTrigger(file), false);
      assert.deepEqual(selectTests([file], packages, fixtures), emptyResult);
    });
  }

  it("selects only the present route guard for a route change", () => {
    assert.deepEqual(selectTests(["server/src/routes/users.ts"], packages, fixtures), {
      wholePackages: [], files: [{ package: "@myrmidon/server", files: [routeGuard] }],
    });
  });

  it("selects shared guards when routes and a shared trigger change", () => {
    assert.deepEqual(selectTests(["server/src/routes/users.ts", "docs/myrmidon/FLAGS.md"], packages, fixtures), sharedResult);
  });

  it("does not synthesize missing shared guards", () => {
    assert.deepEqual(selectTests(["server/src/app.ts"], packages, [{ file: pluginGuard, source: "" }]), {
      wholePackages: [], files: [{ package: "@myrmidon/server", files: [pluginGuard] }],
    });
  });

  it("does not synthesize a missing route guard", () => {
    assert.deepEqual(selectTests(["server/src/routes/users.ts"], packages, [{ file: appGuard, source: "" }]), emptyResult);
  });

  it("selects no guards without the server package", () => {
    assert.deepEqual(selectTests(["server/src/app.ts"], [], fixtures), emptyResult);
    assert.deepEqual(selectTests(["server/src/routes/users.ts"], [], fixtures), emptyResult);
  });

  it("does not duplicate suites for repeated and overlapping triggers", () => {
    assert.deepEqual(selectTests(["server/src/app.ts", "server/src/app.ts", "server/src/routes/users.ts", "docs/myrmidon/FLAGS.md"], packages, fixtures), sharedResult);
  });

  it("returns the same sorted files when testFiles are reversed", () => {
    assert.deepEqual(selectTests(["server/src/app.ts"], packages, [...fixtures].reverse()), sharedResult);
    assert.deepEqual(selectTests(["server/src/app.ts"], packages, fixtures), sharedResult);
  });
});
