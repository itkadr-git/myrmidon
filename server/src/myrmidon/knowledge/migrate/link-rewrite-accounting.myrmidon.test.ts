import { describe, expect, it } from "vitest";
import { findLinks, resolvedPercent, rewriteLinks, splitLinkTarget } from "./links.js";

describe("knowledge link rewrite accounting", () => {
  it("splits normalized targets while preserving anchors and aliases verbatim", () => {
    expect(splitLinkTarget("  Page Name  #section|label#hash|extra  ")).toEqual({
      target: "Page Name",
      suffix: "#section|label#hash|extra  ",
    });
    expect(splitLinkTarget(" page |alias#hash|other")).toEqual({
      target: "page",
      suffix: "|alias#hash|other",
    });
    expect(splitLinkTarget("")).toBeNull();
    expect(splitLinkTarget("  |alias")).toBeNull();
    expect(splitLinkTarget(" #anchor|alias")).toBeNull();
  });

  it("finds valid occurrences and rewrites only resolved targets across lines", () => {
    const input = [
      "Start [[  Known  #part|label#hash|other]] and [[ missing #top| A |B ]]",
      "[[Second]] / [[missing|again]] / [[ known ]] / [[Second#x]]",
      "Ignored: [[]] [[  |alias]] [[#anchor]]; unfinished [[ remains.",
    ].join("\n");
    const calls: string[] = [];
    const result = rewriteLinks(input, (target) => {
      calls.push(target);
      return target === "Known" ? "docs/known" : target === "known" ? "docs/lower" : null;
    });

    expect(findLinks(input)).toEqual([
      { target: "Known", suffix: "#part|label#hash|other" },
      { target: "missing", suffix: "#top| A |B " },
      { target: "Second", suffix: "" },
      { target: "missing", suffix: "|again" },
      { target: "known", suffix: "" },
      { target: "Second", suffix: "#x" },
    ]);
    expect(calls).toEqual(["Known", "missing", "Second", "missing", "known", "Second"]);
    expect(result).toEqual({
      content: [
        "Start [[docs/known#part|label#hash|other]] and [[ missing #top| A |B ]]",
        "[[Second]] / [[missing|again]] / [[docs/lower]] / [[Second#x]]",
        "Ignored: [[]] [[  |alias]] [[#anchor]]; unfinished [[ remains.",
      ].join("\n"),
      total: 6,
      resolved: 2,
      unresolved: ["missing", "Second"],
    });
  });

  it("reports rounded resolved percentages, including an empty input", () => {
    expect(resolvedPercent(0, 0)).toBe(100);
    expect(resolvedPercent(1, 3)).toBe(33.3);
    expect(resolvedPercent(2, 3)).toBe(66.7);
    expect(resolvedPercent(9, 10)).toBe(90);
  });
});
