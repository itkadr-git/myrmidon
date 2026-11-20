import assert from "node:assert/strict";
import test from "node:test";

import { prepareNpmReadme } from "../prepare-npm-readme.mjs";

const base = "https://raw.githubusercontent.com/paperclipai/paperclip/release-one/doc/assets/";

test("preserves bytes surrounding quoted srcsets and rewrites only relative candidates", () => {
  const input = [
    "before \u2603 [manual](doc/assets/manual.md)",
    '<source srcset="doc/assets/one.png 1x,  https://example.org/two.png 2x,\tdoc/assets/three.png 640w">',
    "<source srcset='https://example.org/doc/assets/one.png 1x, doc/assets/two.png 2x,  doc/assets/three.png 640w'>",
    '<img src="doc/assets/banner.png" alt="caf\u00e9">',
    "<img src='https://example.org/doc/assets/unchanged.png'> after",
  ].join("\r\n");
  const expected = [
    "before \u2603 [manual](doc/assets/manual.md)",
    `<source srcset="${base}one.png 1x,  https://example.org/two.png 2x,\t${base}three.png 640w">`,
    `<source srcset='https://example.org/doc/assets/one.png 1x, ${base}two.png 2x,  ${base}three.png 640w'>`,
    `<img src="${base}banner.png" alt="caf\u00e9">`,
    "<img src='https://example.org/doc/assets/unchanged.png'> after",
  ].join("\r\n");

  assert.equal(prepareNpmReadme(input, "release-one"), expected);
  assert.equal(prepareNpmReadme(expected, "release-one"), expected);
});

test("asset refs are independent across calls", () => {
  const input = '<img src="doc/assets/example.png">';
  assert.equal(prepareNpmReadme(input, "release-one"), `<img src="${base}example.png">`);
  assert.equal(
    prepareNpmReadme(input, "release-two"),
    '<img src="https://raw.githubusercontent.com/paperclipai/paperclip/release-two/doc/assets/example.png">',
  );
  assert.equal(prepareNpmReadme(input, "release-one"), `<img src="${base}example.png">`);
});

test("rejects an empty asset ref", () => {
  assert.throws(() => prepareNpmReadme('<img src="doc/assets/example.png">', ""), /immutable README asset ref is required/);
});
