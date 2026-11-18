import assert from "node:assert/strict";
import test from "node:test";

import { collectNavPages } from "./generate-llms-txt.mjs";

function nav(tabs) {
  return { navigation: { tabs } };
}

function pages(...values) {
  return [{ tab: "Docs", groups: [{ group: "Pages", pages: values }] }];
}

test("missing navigation throws", () => {
  assert.throws(() => collectNavPages({}), /missing or not an array/);
});

test("null navigation throws", () => {
  assert.throws(() => collectNavPages({ navigation: null }), /missing or not an array/);
});

test("missing navigation.tabs throws", () => {
  assert.throws(() => collectNavPages({ navigation: {} }), /missing or not an array/);
});

test("null navigation.tabs throws", () => {
  assert.throws(() => collectNavPages(nav(null)), /missing or not an array/);
});

test("object navigation.tabs throws", () => {
  assert.throws(() => collectNavPages({ navigation: { tabs: {} } }), /missing or not an array/);
});

test("empty tabs returns exactly an empty array", () => {
  assert.deepEqual(collectNavPages(nav([])), []);
});

test("tab without groups is skipped", () => {
  assert.deepEqual(collectNavPages(nav([{ tab: "Empty" }])), []);
});

test("group without pages is skipped", () => {
  assert.deepEqual(collectNavPages(nav([{ tab: "Docs", groups: [{ group: "Empty" }] }])), []);
});

test("multiple tabs preserve tab order", () => {
  const tabs = [
    { tab: "First", groups: [{ group: "G", pages: ["first/page"] }] },
    { tab: "Second", groups: [{ group: "G", pages: ["second/page"] }] },
  ];
  assert.deepEqual(collectNavPages(nav(tabs)), ["first/page", "second/page"]);
});

test("multiple groups preserve group order", () => {
  const tabs = [{
    tab: "Docs",
    groups: [
      { group: "First", pages: ["first/page"] },
      { group: "Second", pages: ["second/page"] },
    ],
  }];
  assert.deepEqual(collectNavPages(nav(tabs)), ["first/page", "second/page"]);
});

test("repeated pages across tabs keep first occurrence order", () => {
  const tabs = [
    { tab: "First", groups: [{ group: "G", pages: ["shared/page", "first/page"] }] },
    { tab: "Second", groups: [{ group: "G", pages: ["second/page", "shared/page"] }] },
    { tab: "Third", groups: [{ group: "G", pages: ["first/page", "third/page"] }] },
  ];
  assert.deepEqual(collectNavPages(nav(tabs)), [
    "shared/page",
    "first/page",
    "second/page",
    "third/page",
  ]);
});

test("repeated pages across groups and tabs keep first occurrence order", () => {
  const tabs = [
    { tab: "First", groups: [
      { group: "One", pages: ["alpha", "shared"] },
      { group: "Two", pages: ["shared", "beta", "alpha"] },
    ] },
    { tab: "Second", groups: [
      { group: "Three", pages: ["beta", "gamma"] },
      { group: "Four", pages: ["shared", "delta", "gamma"] },
    ] },
  ];
  assert.deepEqual(collectNavPages(nav(tabs)), ["alpha", "shared", "beta", "gamma", "delta"]);
});

test("null page throws", () => {
  assert.throws(() => collectNavPages(nav(pages(null))), /not a string/);
});

test("number page throws", () => {
  assert.throws(() => collectNavPages(nav(pages(42))), /not a string/);
});

test("object page throws", () => {
  assert.throws(() => collectNavPages(nav(pages({ page: "docs/page" }))), /not a string/);
});

test("leading space throws", () => {
  assert.throws(() => collectNavPages(nav(pages(" docs/page"))), /clean path/);
});

test("trailing space throws", () => {
  assert.throws(() => collectNavPages(nav(pages("docs/page "))), /clean path/);
});

test("empty string throws", () => {
  assert.throws(() => collectNavPages(nav(pages(""))), /clean path/);
});

test("anchor in the middle throws", () => {
  assert.throws(() => collectNavPages(nav(pages("docs/page#section/child"))), /anchor/);
});

test("anchor at the end throws", () => {
  assert.throws(() => collectNavPages(nav(pages("docs/page#"))), /anchor/);
});
