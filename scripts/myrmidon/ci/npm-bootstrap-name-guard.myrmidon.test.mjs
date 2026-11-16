import assert from "node:assert/strict";
import test from "node:test";

import { validatePackageName } from "../../bootstrap-npm-package.mjs";

test("bootstrap name guard accepts exact scoped name boundaries", () => {
  const valid = [
    "@myrmidon/a",
    "@myrmidon/0",
    "@myrmidon/a.b",
    "@myrmidon/a_b",
    "@myrmidon/a-b",
    "@myrmidon/0._-",
  ];
  for (const name of valid) {
    assert.equal(validatePackageName(name), undefined, name);
  }
});

test("bootstrap name guard rejects names outside its exact boundary", () => {
  const invalid = [
    "",
    "@myrmidon/",
    "@myrmidon/.a",
    "@myrmidon/-a",
    "@myrmidon/_a",
    "@Myrmidon/a",
    "@myrmidon/A",
    "@other/a",
    "a",
    "@myrmidon/a/b",
    " @myrmidon/a",
    "@myrmidon/a ",
    "@myrmidon/a b",
    "@myrmidon/a\t",
    "@myrmidon/a\n",
    "@myrmidon/a\r\n",
  ];
  for (const name of invalid) {
    assert.throws(() => validatePackageName(name), {
      name: "Error",
      message: `refusing to publish a placeholder for ${JSON.stringify(name)}: the name must be a lowercase package inside the @myrmidon scope (this guard prevents accidental publishes to names we do not own).`,
    }, JSON.stringify(name));
  }
});
