import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBrandKey, validateManifest } from "../app-brand-validation.mjs";

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="white" d="M0 0h24v24H0z"/></svg>');
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const row = (overrides = {}) => ({ slug: "alpha", provider: "Alpha", aliases: [], localAsset: "/brands/apps/alpha.svg", ...overrides });
const manifest = (providers = [row()]) => ({ schemaVersion: 1, providers });
const read = (path) => Buffer.from(path.endsWith(".png") ? png : svg);
const check = (providers) => validateManifest(manifest(providers), read);

test("accepts version 1 and an empty providers array", () => assert.equal(validateManifest(manifest([]), read), 0));
for (const version of [undefined, 0, 2, "1", null]) {
  test(`rejects schemaVersion ${String(version)}`, () => assert.throws(() => validateManifest({ ...manifest(), schemaVersion: version }, read), /Invalid brand manifest/));
}
for (const providers of [undefined, null, {}, "providers"]) {
  test(`rejects non-array providers ${String(providers)}`, () => assert.throws(() => validateManifest({ schemaVersion: 1, providers }, read), /Invalid brand manifest/));
}
test("accepts a lowercase hyphenated numeric slug", () => assert.equal(check([row({ slug: "alpha-42" })]), 1));
for (const slug of ["", "Alpha", "-alpha", "alpha-", "alpha--beta", "alpha_beta", "alpha beta", "alpha.beta"]) {
  test(`rejects invalid slug ${JSON.stringify(slug)}`, () => assert.throws(() => check([row({ slug })]), /invalid slug/));
}
test("rejects duplicate slugs", () => assert.throws(() => check([row(), row({ provider: "Other" })]), /Duplicate or invalid slug/));
test("accepts nonblank provider", () => assert.equal(check([row({ provider: " Alpha Inc " })]), 1));
for (const provider of ["", "   ", null, 42]) {
  test(`rejects blank or non-string provider ${JSON.stringify(provider)}`, () => assert.throws(() => check([row({ provider })]), /missing provider name/));
}
test("accepts absent aliases", () => { const r = row(); delete r.aliases; assert.equal(check([r]), 1); });
test("accepts nonempty aliases", () => assert.equal(check([row({ aliases: ["A Company"] })]), 1));
for (const aliases of ["alias", {}, [""], [" \t"], [null], [42]]) {
  test(`rejects invalid aliases ${JSON.stringify(aliases)}`, () => assert.throws(() => check([row({ aliases })]), /invalid aliases/));
}
for (const [input, expected] of [["  ACME  ", "acme"], ["Acme   Tools", "acme-tools"], ["R & D", "r-and-d"], ["!Acme, Inc.?", "acme-inc"], ["A&B", "aandb"]]) {
  test(`normalizes ${JSON.stringify(input)}`, () => assert.equal(normalizeBrandKey(input), expected));
}
for (const alias of [" ALPHA ", "AlPhA", "Alpha!!!"]) {
  test(`rejects cross-row collision ${JSON.stringify(alias)}`, () => assert.throws(() => check([row(), row({ slug: "beta", provider: "Beta", aliases: [alias] })]), /ambiguous brand alias/));
}
test("rejects normalized ampersand collision across providers", () => assert.throws(() => check([row({ provider: "Research & Development" }), row({ slug: "beta", provider: "Research and Development" })]), /ambiguous brand alias/));
test("allows repeated normalized identities within one row", () => assert.equal(check([row({ aliases: ["Alpha", " alpha ", "ALPHA!"] })]), 1));
test("allows distinct identities to share artwork", () => assert.equal(check([row(), row({ slug: "beta", provider: "Beta" })]), 2));
test("reads only light asset when dark asset is absent", () => {
  const calls = []; assert.equal(validateManifest(manifest(), (p) => { calls.push(p); return read(p); }), 1);
  assert.deepEqual(calls, ["/brands/apps/alpha.svg"]);
});
test("deduplicates identical light and dark asset paths", () => {
  const calls = []; assert.equal(validateManifest(manifest([row({ darkAsset: "/brands/apps/alpha.svg" })]), (p) => { calls.push(p); return read(p); }), 1);
  assert.deepEqual(calls, ["/brands/apps/alpha.svg"]);
});
test("reads distinct light then dark paths, deduplicating only per row", () => {
  const calls = []; const rows = [row({ darkAsset: "/brands/apps/dark.png" }), row({ slug: "beta", provider: "Beta", darkAsset: "/brands/apps/dark.png" })];
  assert.equal(validateManifest(manifest(rows), (p) => { calls.push(p); return read(p); }), 2);
  assert.deepEqual(calls, ["/brands/apps/alpha.svg", "/brands/apps/dark.png", "/brands/apps/alpha.svg", "/brands/apps/dark.png"]);
});
test("propagates the original missing asset error", () => {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.throws(() => validateManifest(manifest(), () => { throw error; }), (actual) => actual === error && actual.code === "ENOENT");
});
for (const field of ["localAsset", "darkAsset"]) {
  for (const value of ["/brands/apps/../x.svg", "https://example.com/a.svg", null]) {
    test(`rejects ${field} path ${JSON.stringify(value)}`, () => assert.throws(() => check([row({ [field]: value })]), /invalid asset path/));
  }
}
