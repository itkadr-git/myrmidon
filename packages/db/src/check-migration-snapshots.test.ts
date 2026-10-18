import { describe, expect, it } from "vitest";
import { analyzeSnapshotChain, type SnapshotLink } from "./check-migration-snapshots.js";

const link = (file: string, id: string, prevId: string): SnapshotLink => ({ file, id, prevId });

describe("analyzeSnapshotChain", () => {
  it("accepts a linear chain", () => {
    expect(
      analyzeSnapshotChain([
        link("0302_snapshot.json", "b", "a"),
        link("0303_snapshot.json", "c", "b"),
        link("0304_snapshot.json", "d", "c"),
      ]),
    ).toEqual([]);
  });

  it("flags a duplicate id and a self-referencing prevId (the 0305 collision)", () => {
    const problems = analyzeSnapshotChain([
      link("0304_snapshot.json", "x", "w"),
      link("0305_snapshot.json", "x", "x"),
      link("0306_snapshot.json", "y", "x"),
    ]);
    expect(problems.join("\n")).toContain("duplicate snapshot id x");
    expect(problems.join("\n")).toContain("0305_snapshot.json: prevId points at the snapshot itself");
  });

  it("flags a parent that is not the preceding snapshot from the strict zone on", () => {
    const problems = analyzeSnapshotChain([
      link("0309_snapshot.json", "a", "z"),
      link("0310_snapshot.json", "b", "a"),
      link("0313_snapshot.json", "c", "a"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0313_snapshot.json");
  });

  it("tolerates dangling parents of legacy snapshots", () => {
    expect(
      analyzeSnapshotChain([
        link("0027_snapshot.json", "b", "missing"),
        link("0028_snapshot.json", "c", "b"),
      ]),
    ).toEqual([]);
  });

  it("flags a cycle", () => {
    const problems = analyzeSnapshotChain(
      [link("0001_snapshot.json", "a", "b"), link("0002_snapshot.json", "b", "a")],
      9999,
    );
    expect(problems.join("\n")).toContain("loops back");
  });
});
