import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appPath = new URL("../app.ts", import.meta.url);
const snapshotPath = new URL("./app-plugin.mounts.snapshot.json", import.meta.url);

function readMounts(source: string): string[] {
  const mounts: string[] = [];
  let offset = 0;
  while (true) {
    const start = source.indexOf("api.use(", offset);
    if (start < 0) return mounts;
    let cursor = start + "api.use(".length;
    let depth = 1;
    let quote: string | undefined;
    let escaped = false;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor++];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
    }
    expect(depth).toBe(0);
    mounts.push(source.slice(start, cursor).trim());
    offset = cursor;
  }
}

describe("myrmidon app facade", () => {
  it("keeps every API mount identity, arguments, and order", () => {
    const app = readFileSync(appPath, "utf8");
    const expected = JSON.parse(readFileSync(snapshotPath, "utf8")) as string[];
    expect(readMounts(app)).toEqual(expected);
  });

  it("keeps app.ts at no more than two direct Myrmidon imports", () => {
    const app = readFileSync(appPath, "utf8");
    const importFrom = /\bfrom\s*(["'])(\.\/myrmidon\/[^"']+)\1/g;
    const imports = [...app.matchAll(importFrom)];
    expect(imports).toHaveLength(1);
    expect(imports[0]?.[2]).toBe("./myrmidon/app-plugin.js");
  });
});
