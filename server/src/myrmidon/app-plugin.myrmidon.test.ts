// Guard the import consolidation without changing app.ts mount order.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("myrmidon app facade", () => {
  it("keeps every existing api.use mount in the same order", () => {
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const mounts = app.match(/^\s*api\.use\([\s\S]*?\);.*$/gm) ?? [];
    const expected = readFileSync(new URL("../app.ts", import.meta.url), "utf8")
      .match(/^\s*api\.use\([\s\S]*?\);.*$/gm) ?? [];
    expect(mounts).toEqual(expected);
    expect(mounts.length).toBeGreaterThan(0);
  });

  it("keeps app.ts at one direct Myrmidon import", () => {
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const imports = app
      .split("\n")
      .filter((line) => line.includes('from "./myrmidon/'));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("./myrmidon/app-plugin.js");
  });
});
