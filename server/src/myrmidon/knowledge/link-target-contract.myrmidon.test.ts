import { describe, expect, it } from "vitest";
import { extractLinkTargets, normalizeLinkTarget } from "./domain.js";

describe("knowledge link target contract", () => {
  it.each([
    ["plain target", "a/b", "a/b"],
    ["alias", "a/b|Label", "a/b"],
    ["anchor", "a/b#section", "a/b"],
    ["anchor and alias", "a/b#section|Label", "a/b"],
    ["surrounding spaces", "  a/b  ", "a/b"],
    ["spaces with alias", " a/b | Label ", "a/b"],
    ["spaces with anchor", " a/b # section ", "a/b"],
    ["empty", "", null],
    ["whitespace", "  ", null],
    ["anchor only", "#section", null],
    ["alias only", "|Label", null],
    ["blank before anchor", "  #section|Label", null],
    ["case preserved", "Ops/RunBook#Section", "Ops/RunBook"],
    ["no slug validation", "not a valid slug!|Label", "not a valid slug!"],
    ["alias before anchor", "a/b|Label#section", "a/b"],
    ["empty anchor", "a/b#", "a/b"],
    ["empty alias", "a/b|", "a/b"],
  ])("normalizes %s", (_name, raw, expected) => {
    expect(normalizeLinkTarget(raw)).toBe(expected);
  });

  it.each([
    ["plain link", "See [[a/b]].", ["a/b"]],
    ["alias", "[[a/b|Label]]", ["a/b"]],
    ["anchor", "[[a/b#section]]", ["a/b"]],
    ["anchor and alias", "[[a/b#section|Label]]", ["a/b"]],
    ["target whitespace", "[[  a/b  #section|Label]]", ["a/b"]],
    ["empty and anchor-only", "[[]] [[ ]] [[#section]] [[|Label]]", []],
    ["JSON prose", '{"target":"a/b","label":"Label"}', []],
    ["Markdown prose", "[Label](a/b) and # section", []],
    ["unclosed link", "See [[a/b", []],
    ["newline in link", "[[a/\nb]]", []],
    ["case is distinct", "[[A/B]] [[a/b]] [[A/B#top]]", ["A/B", "a/b"]],
    ["slug grammar not validated", "[[Not a slug!]]", ["Not a slug!"]],
    ["first-seen order and deduplication", "[[b|First]] [[a#one]] [[b#two|Second]] [[c]] [[a|Third]]", ["b", "a", "c"]],
    ["malformed followed by valid", "[[broken\n then [[valid]]", ["valid"]],
  ])("extracts %s", (_name, content, expected) => {
    expect(extractLinkTargets(content)).toEqual(expected);
  });
});
