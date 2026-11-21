import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";

describe("lazy database driver identity", () => {
  it("returns the same ESM database class exposed to consumers", async () => {
    const db = createDb("postgres://localhost:5432/unused");
    try {
      expect(db).toBeInstanceOf(PostgresJsDatabase);
    } finally {
      await db.$client.end();
    }
  });
});
