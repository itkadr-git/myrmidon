import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArtwork } from "../app-brand-validation.mjs";

// This validator checks structural patterns; acceptance does not imply valid XML or rendering.
const cases = [
  ["double-quoted viewBox", '<svg viewBox="0 0 24 24"/>', true],
  ["single-quoted viewBox", "<svg viewBox='0 0 24 24'/>", true],
  ["viewBox with whitespace", '<svg viewBox = "0 0 1 1"/>', true],
  ["viewBox with width only", '<svg viewBox="0 0 1 1" width="1"/>', true],
  ["numeric dimensions", '<svg width="24" height="32"/>', true],
  ["pixel dimensions", '<svg width="24px" height="32px"/>', true],
  ["mixed dimension units and quotes", "<svg width='1.5px' height=\"2\"/>", true],
  ["width without height", '<svg width="24"/>', false],
  ["height without width", '<svg height="24"/>', false],
  ["empty viewBox", '<svg viewBox=""/>', false],
  ["empty single-quoted viewBox", "<svg viewBox=''/>", false],
  ["no geometry", '<svg/>', false],
  ["percent dimensions", '<svg width="100%" height="100%"/>', false],
  ["empty width", '<svg width="" height="24"/>', false],
  ["empty height", '<svg width="24" height=""/>', false],
  ["unquoted dimensions", '<svg width=24 height=24/>', false],
  ["dimensions on child only", '<svg><rect width="24" height="24"/></svg>', false],
  ["local href", '<svg viewBox="0 0 1 1"><use href="#shape"/></svg>', true],
  ["local xlink href", '<svg viewBox="0 0 1 1"><use xlink:href="#shape"/></svg>', true],
  ["native defs, gradient, path and local paint", '<svg viewBox="0 0 24 24"><defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient><path id="shape" d="M0 0h1v1z"/></defs><path fill="url(#gradient)" d="M0 0h24v24z"/></svg>', true],
  ["default namespace exemption", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', true],
  ["prefixed namespace exemption", '<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#shape"/></svg>', true],
  ["nonempty viewBox is structural, not parsed", '<svg viewBox="not four numbers"/>', true],
  ["missing svg root marker", '<rect viewBox="0 0 1 1"/>', false],
];

for (const [name, source, accepted] of cases) {
  test(name, () => {
    const validate = () => validateArtwork(Buffer.from(source), "art.svg");
    if (accepted) assert.doesNotThrow(validate);
    else assert.throws(validate, /SVG requires a viewBox or intrinsic width and height/);
  });
}

test("external href is rejected while a local href is accepted", () => {
  assert.doesNotThrow(() => validateArtwork(Buffer.from('<svg viewBox="0 0 1 1"><use href="#shape"/></svg>'), "art.svg"));
  assert.throws(() => validateArtwork(Buffer.from('<svg viewBox="0 0 1 1"><use href="https://example.invalid/art.svg#shape"/></svg>'), "art.svg"), /unsafe SVG feature/);
});

test("external paint URL is rejected while local paint is accepted", () => {
  assert.doesNotThrow(() => validateArtwork(Buffer.from('<svg viewBox="0 0 1 1"><path fill="url(#gradient)"/></svg>'), "art.svg"));
  assert.throws(() => validateArtwork(Buffer.from('<svg viewBox="0 0 1 1"><path fill="url(https://example.invalid/g)"/></svg>'), "art.svg"), /unsafe SVG feature/);
});

test("SVG geometry is not accepted under another filename extension", () => {
  assert.throws(() => validateArtwork(Buffer.from('<svg viewBox="0 0 1 1"/>'), "art.txt"), /SVG requires/);
});

test("PNG signature branch has both a valid and invalid control", () => {
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  assert.doesNotThrow(() => validateArtwork(Buffer.from(original), "art.png"));
  const corrupt = Buffer.from(original);
  corrupt[0] = 0;
  assert.throws(() => validateArtwork(corrupt, "art.png"), /invalid PNG signature/);
});
