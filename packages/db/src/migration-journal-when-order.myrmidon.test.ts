import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// myrmidon: drizzle skips a migration whose journal `when` is not greater than
// the last applied one. Every entry from 0308 on must therefore carry a
// strictly increasing `when`, in idx order.
describe("migrations journal: `when` is strictly increasing from 0308", () => {
  it("has no entry whose when is not greater than the previous one", () => {
    const journal = JSON.parse(
      readFileSync(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const tail = journal.entries.filter((entry) => entry.idx >= 307);
    for (let i = 1; i < tail.length; i += 1) {
      expect(tail[i]!.when, `${tail[i]!.tag} must be later than ${tail[i - 1]!.tag}`).toBeGreaterThan(tail[i - 1]!.when);
    }
  });
});
