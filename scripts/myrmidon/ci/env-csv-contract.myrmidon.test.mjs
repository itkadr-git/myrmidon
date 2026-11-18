import assert from "node:assert/strict";
import test from "node:test";

import { checkRegistry, parseCsv } from "../../check-env-registry.mjs";

const parseCases = [
  ["quoted comma", 'a,"b,c",d', [["a", "b,c", "d"]]],
  ["escaped double quote", 'a,"b ""c""",d', [["a", 'b "c"', "d"]]],
  ["newline inside quoted cell", 'a,"b\nc",d\nx,y,z', [["a", "b\nc", "d"], ["x", "y", "z"]]],
  ["CRLF row separators", "a,b\r\nc,d\r\n", [["a", "b"], ["c", "d"]]],
  ["CRLF inside quoted cell", 'a,"b\r\nc"\r\n', [["a", "b\r\nc"]]],
  ["final newline", "a,b\n", [["a", "b"]]],
  ["no final newline", "a,b", [["a", "b"]]],
  ["empty middle cell", "a,,c", [["a", "", "c"]]],
  ["trailing empty cell", "a,b,", [["a", "b", ""]]],
  ["empty input", "", []],
  ["empty line", "\n", [[""]]],
];

for (const [name, input, expected] of parseCases) {
  test(`parseCsv: ${name}`, () => assert.deepEqual(parseCsv(input), expected));
}

const entry = (name) => ({
  name,
  classification: "product",
  scope: "instance",
  consumer: "fixture",
  ui_or_store: "fixture",
  secret_ref_or_instance_setup: "fixture",
  ticket_or_pr: "fixture",
  decision: "fixture",
});
const registry = {
  entries: [entry("MYRMIDON_ALPHA"), entry("MYRMIDON_BETA")],
  counts: { unique_names: 2, secret: 0, infra: 0, product: 2 },
  dynamic_patterns: [],
};
const mismatch = ["CSV rows do not match JSON entries (name order/count)"];
const registryCases = [
  ["exact name order", "name\nMYRMIDON_ALPHA\nMYRMIDON_BETA\n", []],
  ["missing name column", "other\nMYRMIDON_ALPHA\nMYRMIDON_BETA\n", ["CSV has no name column"]],
  ["reordered rows", "name\nMYRMIDON_BETA\nMYRMIDON_ALPHA\n", mismatch],
  ["extra row", "name\nMYRMIDON_ALPHA\nMYRMIDON_BETA\nMYRMIDON_GAMMA\n", mismatch],
  ["missing row", "name\nMYRMIDON_ALPHA\n", mismatch],
  ["name column not first", "description,name\nfirst,MYRMIDON_ALPHA\nsecond,MYRMIDON_BETA\n", []],
  ["empty lines ignored", "\nname\n\nMYRMIDON_ALPHA\n\nMYRMIDON_BETA\n\n", []],
  ["empty name cell is not an empty line", "name,description\nMYRMIDON_ALPHA,first\n,second\n", mismatch],
  ["empty CSV has no name column", "", ["CSV has no name column"]],
  ["header only has missing rows", "name\n", mismatch],
];

for (const [name, csvText, expected] of registryCases) {
  test(`checkRegistry CSV: ${name}`, () => {
    assert.deepEqual(checkRegistry({ extracted: new Map(), registry, csvText, dynamic: new Map() }), expected);
  });
}
