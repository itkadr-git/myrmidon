import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenCatalog,
  validateGuardedSource,
  runPrecheck,
} from "./precheck.mts";
import * as realScanner from "../../../ui/src/i18n/guard-scan.ts";

test("flattenCatalog flattens nested catalog objects to dot-separated keys", () => {
  const catalog = {
    settings: {
      title: "Settings",
      auth: {
        token: "Token",
      },
    },
    common: {
      save: "Save",
    },
  };
  const flat = flattenCatalog(catalog);
  assert.equal(flat["settings.title"], 1);
  assert.equal(flat["settings.auth.token"], 1);
  assert.equal(flat["common.save"], 1);
  assert.equal(flat["missing.key"], undefined);
});

test("validateGuardedSource catches English literals with real guard scanner", () => {
  const enCatalogs = { "common.save": 1 };
  const sampleCode = `
    export function Button() {
      return <button aria-label="Submit button">Save</button>;
    }
  `;
  const issues = validateGuardedSource("components/Button.tsx", sampleCode, enCatalogs, realScanner);
  assert.ok(issues.length >= 1);
  assert.equal(issues[0].kind, "ENGLISH");
  assert.match(issues[0].message, /English literal/);
});

test("validateGuardedSource catches missing area keys with real guard scanner", () => {
  const enCatalogs = { "area.known.button": 1 };
  const sampleCode = `
    export function Screen() {
      const { t } = useI18n();
      return <div>{t("area.missing.button")}</div>;
    }
  `;
  const issues = validateGuardedSource("components/Screen.tsx", sampleCode, enCatalogs, realScanner);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "NOKEY");
  assert.match(issues[0].message, /area\.missing\.button.*not found/);
});

test("validateGuardedSource accepts plural forms _one and _other with real guard scanner", () => {
  const enCatalogs = { "area.items.count_other": 1 };
  const sampleCode = `
    export function Screen() {
      const { t } = useI18n();
      return <div>{t("area.items.count", { count: 5 })}</div>;
    }
  `;
  const issues = validateGuardedSource("components/Screen.tsx", sampleCode, enCatalogs, realScanner);
  assert.equal(issues.length, 0);
});

test("runPrecheck passes on real repo ui/src directory", async () => {
  const result = await runPrecheck("ui/src");
  assert.equal(result.bad, 0);
  assert.ok(result.totalFiles > 0);
  assert.equal(result.issues.length, 0);
});
