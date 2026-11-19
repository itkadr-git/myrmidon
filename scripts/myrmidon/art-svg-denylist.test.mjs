import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArtwork } from "../app-brand-validation.mjs";

const wrap = (body, attributes = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${attributes}>${body}</svg>`);
const cases = [
  ["DOCTYPE", '<!DOCTYPE svg>', '<desc>DOCTYPE</desc>'],
  ["ENTITY", '<!ENTITY x "value">', '<desc>ENTITY</desc>'],
  ["xml-stylesheet", '<?xml-stylesheet href="theme"?>', '<desc>xml-stylesheet</desc>'],
  ["decimal numeric entity", '<text>&#65;</text>', '<text>A</text>'],
  ["hex numeric entity", '<text>&#x41;</text>', '<text>A</text>'],
  ["script", '<script/>', '<desc>script</desc>'],
  ["namespaced mixed-case script", '<s:ScRiPt/>', '<desc>script</desc>'],
  ["foreignObject", '<foreignObject/>', '<g/>'],
  ["namespaced foreignObject", '<s:foreignObject/>', '<g/>'],
  ["image", '<image/>', '<path/>'],
  ["mixed-case image", '<ImAgE/>', '<path/>'],
  ["feImage", '<feImage/>', '<feGaussianBlur/>'],
  ["namespaced feImage", '<s:feImage/>', '<feGaussianBlur/>'],
  ["iframe", '<iframe/>', '<g/>'],
  ["object", '<object/>', '<g/>'],
  ["embed", '<embed/>', '<g/>'],
  ["animate", '<animate/>', '<g/>'],
  ["animateTransform", '<animateTransform/>', '<g/>'],
  ["namespaced animateMotion", '<s:animateMotion/>', '<g/>'],
  ["set", '<set/>', '<g/>'],
  ["anchor", '<a/>', '<g/>'],
  ["namespaced uppercase anchor", '<s:A/>', '<g/>'],
  ["onload", '<path onload="x()"/>', '<path opacity="1"/>'],
  ["mixed-case event", '<path onClick="x()"/>', '<path opacity="1"/>'],
  ["hyphenated event", '<path on-custom="x"/>', '<path opacity="1"/>'],
  ["relative href", '<use href="other.svg#x"/>', '<use href="#x"/>'],
  ["absolute href", '<use href="https://example.test/x"/>', '<use href="#x"/>'],
  ["empty href", '<use href=""/>', '<use href="#x"/>'],
  ["xlink href", '<use xlink:href="other.svg#x"/>', '<use xlink:href="#x"/>'],
  ["mixed-case namespaced href", '<use XLINK:HREF="other.svg"/>', '<use xlink:href="#x"/>'],
  ["external url", '<path fill="url(other.svg#x)"/>', '<path fill="url(#x)"/>'],
  ["quoted external url", "<path fill=\"url('other.svg#x')\"/>", '<path fill="url(#x)"/>'],
  ["import", '<style>@import "theme.css"</style>', '<style>.x { fill: red }</style>'],
  ["mixed-case import", '<style>@IMPORT "theme.css"</style>', '<style>.x { fill: red }</style>'],
  ["media", '<style>@media screen {}</style>', '<style>.x { fill: red }</style>'],
  ["javascript scheme", '<text>javascript:alert(1)</text>', '<text>javascript</text>'],
  ["data scheme", '<text>data:image/png</text>', '<text>data</text>'],
  ["http scheme", '<text>http://example.test</text>', '<text>http</text>'],
  ["https scheme", '<text>HTTPS://example.test</text>', '<text>https</text>'],
  ["backslash", '<text>\\</text>', '<text>slash</text>'],
];

for (const [name, unsafe, clean] of cases) {
  test(`rejects ${name} with paired clean control`, () => {
    assert.doesNotThrow(() => validateArtwork(wrap(clean), "control.svg"));
    assert.throws(() => validateArtwork(wrap(unsafe), "unsafe.svg"), /unsafe/);
  });
}

test("accepts safe SVG and namespace declarations", () => {
  assert.doesNotThrow(() => validateArtwork(wrap('<use xlink:href="#shape"/>', 'xmlns:xlink="http://www.w3.org/1999/xlink"'), "safe.svg"));
});
