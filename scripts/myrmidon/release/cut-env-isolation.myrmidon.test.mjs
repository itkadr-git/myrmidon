import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFromEnv } from "./cut-rc.mjs";

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

test("board configuration stays isolated between frozen company environments", () => {
  const keyA = ["alpha", "credential"].join("-");
  const keyB = ["beta", "credential"].join("-");
  const envA = deepFreeze({ PAPERCLIP_API_URL: "https://alpha.example///", PAPERCLIP_API_KEY: keyA, PAPERCLIP_COMPANY_ID: "company-alpha" });
  const envB = deepFreeze({ PAPERCLIP_API_URL: "https://beta.example/", PAPERCLIP_API_KEY: keyB, PAPERCLIP_COMPANY_ID: "company-beta" });

  const a = boardFromEnv(envA);
  const b = boardFromEnv(envB);
  assert.equal(a.apiUrl, "https://alpha.example");
  assert.ok(a.apiKey === keyA, "first company credential matches");
  assert.equal(a.companyId, "company-alpha");
  assert.equal(b.apiUrl, "https://beta.example");
  assert.ok(b.apiKey === keyB, "second company credential matches");
  assert.equal(b.companyId, "company-beta");
  const again = boardFromEnv(envA);
  assert.equal(again.apiUrl, "https://alpha.example");
  assert.ok(again.apiKey === keyA, "repeated call uses its own credential");
  assert.equal(again.companyId, "company-alpha");
});

test("empty environment falls back to production defaults without inheriting previous values", () => {
  boardFromEnv(deepFreeze({ PAPERCLIP_API_URL: "https://other.example/", PAPERCLIP_API_KEY: ["other", "credential"].join("-"), PAPERCLIP_COMPANY_ID: "company-other" }));
  const defaults = boardFromEnv(deepFreeze({}));
  assert.equal(defaults.apiUrl, "http://127.0.0.1:3100");
  assert.equal(defaults.companyId, "2870b911-483a-4091-9f15-183841811143");
  assert.ok(defaults.apiKey === undefined, "credential is absent");
});
