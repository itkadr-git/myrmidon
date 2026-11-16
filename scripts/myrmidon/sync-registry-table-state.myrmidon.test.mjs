import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDivergence } from "./vendor-sync/lib.mjs";

const cases = [
  ["rows before a section have a null section", "| ID | Value |\n| --- | --- |\n| a | one |", [{ section: null, id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }]],
  ["a new section resets headers", "## First\n| ID | Old |\n| a | one |\n## Second\n| Key | New |\n| b | two |", [{ section: "First", id: "a", cells: { ID: "a", Old: "one" }, raw: "| a | one |" }, { section: "Second", id: "b", cells: { Key: "b", New: "two" }, raw: "| b | two |" }]],
  ["a blank line ends a table", "| ID | Value |\n| a | one |\n\n| Key | Other |\n| b | two |", [{ section: null, id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }, { section: null, id: "b", cells: { Key: "b", Other: "two" }, raw: "| b | two |" }]],
  ["ordinary text ends a table", "| ID | Value |\n| a | one |\ntext\n| Key | Other |\n| b | two |", [{ section: null, id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }, { section: null, id: "b", cells: { Key: "b", Other: "two" }, raw: "| b | two |" }]],
  ["a new header is not data", "| ID | Value |\n| a | one |\n\n| Key | Other |\n| --- | --- |", [{ section: null, id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }]],
  ["alignment separators are ignored", "| ID | Value |\n| :--- | ---: |\n| a | one |", [{ section: null, id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }]],
  ["short rows fill missing cells", "| ID | Value | Extra |\n| a | one |", [{ section: null, id: "a", cells: { ID: "a", Value: "one", Extra: "" }, raw: "| a | one |" }]],
  ["extra cells do not create columns", "| ID | Value |\n| a | one | ignored |", [{ section: null, id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one | ignored |" }]],
  ["section id and raw whitespace are trimmed", "##   Section   \n| ID | Value |\n   |  a  |  one  |   ", [{ section: "Section", id: "a", cells: { ID: "a", Value: "one" }, raw: "|  a  |  one  |" }]],
  ["CRLF input is supported", "## Section\r\n| ID | Value |\r\n| --- | --- |\r\n| a | one |\r\n", [{ section: "Section", id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }]],
  ["empty markdown has no rows", "", []],
  ["two tables in a section retain that section", "## Section\n| ID | Value |\n| a | one |\n\n| Key | Other |\n| b | two |", [{ section: "Section", id: "a", cells: { ID: "a", Value: "one" }, raw: "| a | one |" }, { section: "Section", id: "b", cells: { Key: "b", Other: "two" }, raw: "| b | two |" }]],
  ["rows retain input order across sections", "## A\n| ID |\n| z |\n| a |\n## B\n| ID |\n| m |", [{ section: "A", id: "z", cells: { ID: "z" }, raw: "| z |" }, { section: "A", id: "a", cells: { ID: "a" }, raw: "| a |" }, { section: "B", id: "m", cells: { ID: "m" }, raw: "| m |" }]],
];

for (const [name, markdown, expected] of cases) {
  test(name, () => assert.deepEqual(parseDivergence(markdown), expected));
}
