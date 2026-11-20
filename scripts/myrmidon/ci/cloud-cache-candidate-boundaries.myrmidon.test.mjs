import assert from "node:assert/strict";
import test from "node:test";
import { cloudCacheCandidates, selectCloudCache } from "../../select-cloud-cache.mjs";

const image = "ghcr.io/owner/repo";
const sha = "a".repeat(40);
const legacy = `${image}:buildcache-cloud`;

for (const [name, value] of [
  ["lowercase", "ghcr.io/owner/repo"],
  ["digits", "ghcr.io/owner123/repo456"],
  ["dot", "ghcr.io/owner.name/repo.name"],
  ["underscore", "ghcr.io/owner_name/repo_name"],
  ["dash", "ghcr.io/owner-name/repo-name"],
]) {
  test(`accepts image ${name}`, () => {
    assert.deepEqual(cloudCacheCandidates(value, [sha]), [
      `${value}:buildcache-cloud-${sha}`,
      `${value}:buildcache-cloud`,
    ]);
  });
}

for (const [name, value] of [
  ["uppercase owner", "ghcr.io/Owner/repo"],
  ["uppercase repository", "ghcr.io/owner/Repo"],
  ["extra segment", "ghcr.io/owner/repo/extra"],
  ["tag", "ghcr.io/owner/repo:tag"],
  ["digest", `ghcr.io/owner/repo@sha256:${"a".repeat(64)}`],
  ["leading whitespace", " ghcr.io/owner/repo"],
  ["trailing whitespace", "ghcr.io/owner/repo "],
  ["embedded newline", "ghcr.io/owner/\nrepo"],
  ["trailing newline", "ghcr.io/owner/repo\n"],
  ["missing owner", "ghcr.io//repo"],
  ["missing repository", "ghcr.io/owner/"],
]) {
  test(`rejects image ${name}`, () => {
    assert.throws(() => cloudCacheCandidates(value, [sha]), /GHCR owner\/repository/);
  });
}

for (const [name, commits] of [
  ["39 characters", ["a".repeat(39)]],
  ["41 characters", ["a".repeat(41)]],
  ["uppercase", ["A".repeat(40)]],
  ["nonhex", ["g".repeat(40)]],
  ["empty ancestry", []],
  ["trailing newline", [`${sha}\n`]],
]) {
  test(`rejects SHA ${name}`, () => {
    assert.throws(() => cloudCacheCandidates(image, commits), /full commit SHAs/);
  });
}

test("accepts exactly 40 lowercase hexadecimal characters", () => {
  const mixed = "0123456789abcdef".repeat(2) + "01234567";
  assert.deepEqual(cloudCacheCandidates(image, [mixed]), [
    `${image}:buildcache-cloud-${mixed}`,
    legacy,
  ]);
});

test("deduplicates before limiting to ten and preserves ancestry order", async () => {
  const unique = Array.from({ length: 15 }, (_, i) => i.toString(16).repeat(40));
  const input = [unique[0], unique[1], unique[0], unique[2], unique[3], unique[1], ...unique.slice(4)];
  const expected = unique.slice(0, 10).map((commit) => `${image}:buildcache-cloud-${commit}`);
  expected.push(legacy);
  assert.deepEqual(cloudCacheCandidates(image, input), expected);
  const inspected = [];
  const result = await selectCloudCache(image, input, {
    exists: async (ref) => { inspected.push(ref); return ref === legacy; },
    log() {},
  });
  assert.equal(result, `type=registry,ref=${legacy}`);
  assert.deepEqual(inspected, expected);
});

test("validates an invalid eleventh unique SHA before limiting candidates", () => {
  const ten = Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(40));
  assert.throws(() => cloudCacheCandidates(image, [...ten, "invalid"]), /full commit SHAs/);
});
