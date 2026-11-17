import { createRequire } from "node:module";
import path from "node:path";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { installPgvectorIntoEmbeddedCluster } from "./test-pgvector.js";

const require = createRequire(import.meta.url);

describe("pgvector installer isolation", () => {
  it("keeps the extension available after another installation is cleaned up", async () => {
    const first = await installPgvectorIntoEmbeddedCluster();
    expect(first.ok, first.reason).toBe(true);
    const second = await installPgvectorIntoEmbeddedCluster();
    expect(second.ok, second.reason).toBe(true);
    const root = path.resolve(path.dirname(path.dirname(require.resolve("embedded-postgres"))), "..", "@embedded-postgres", `linux-${process.arch}`, "native");
    try {
      await first.cleanup();
      await second.cleanup();
      await expect(access(path.join(root, "share", "postgresql", "extension", "vector.control"))).resolves.toBeUndefined();
      await expect(access(path.join(root, "lib", "postgresql", "vector.so"))).resolves.toBeUndefined();
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  }, 120_000);
});
