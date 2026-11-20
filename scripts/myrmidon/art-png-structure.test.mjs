import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArtwork } from "../app-brand-validation.mjs";

const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const changed = (edit) => {
  const bytes = Buffer.from(original);
  edit(bytes);
  return bytes;
};

const cases = [
  ["accepts native PNG", () => Buffer.from(original), true],
  ["rejects length 0", () => original.subarray(0, 0), false],
  ["rejects length 7", () => original.subarray(0, 7), false],
  ["rejects length 8", () => original.subarray(0, 8), false],
  ["rejects length 44", () => original.subarray(0, 44), false],
  ["accepts structural minimum length 45", () => Buffer.concat([original.subarray(0, 37), original.subarray(-8)]), true],
  ["rejects first signature byte", () => changed((b) => { b[0] ^= 1; }), false],
  ["rejects last signature byte", () => changed((b) => { b[7] ^= 1; }), false],
  ["rejects incorrect IHDR", () => changed((b) => { b.write("XHDR", 12); }), false],
  ["rejects lowercase IHDR", () => changed((b) => { b.write("ihdr", 12); }), false],
  ["rejects zero width", () => changed((b) => { b.writeUInt32BE(0, 16); }), false],
  ["rejects zero height", () => changed((b) => { b.writeUInt32BE(0, 20); }), false],
  ["accepts width 2", () => changed((b) => { b.writeUInt32BE(2, 16); }), true],
  ["accepts height 2", () => changed((b) => { b.writeUInt32BE(2, 20); }), true],
  ["accepts large nonzero dimensions", () => changed((b) => { b.writeUInt32BE(0xffffffff, 16); b.writeUInt32BE(0xffffffff, 20); }), true],
  ["rejects incorrect IEND", () => changed((b) => { b.write("XEND", b.length - 8); }), false],
  ["rejects lowercase IEND", () => changed((b) => { b.write("iend", b.length - 8); }), false],
  ["rejects missing IEND tail", () => original.subarray(0, original.length - 8), false],
  ["rejects bytes appended after IEND", () => Buffer.concat([original, Buffer.from([0])]), false],
  ["rejects SVG bytes with PNG extension", () => Buffer.from('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'), false],
];

for (const [name, makeBytes, accepted] of cases) {
  test(name, () => {
    const bytes = Buffer.from(makeBytes());
    const before = Buffer.from(bytes);
    try {
      if (accepted) assert.doesNotThrow(() => validateArtwork(bytes, "fixture.png"));
      else assert.throws(() => validateArtwork(bytes, "fixture.png"), /PNG/);
    } finally {
      assert.deepEqual(bytes, before, "validation must not mutate input bytes");
    }
  });
}
