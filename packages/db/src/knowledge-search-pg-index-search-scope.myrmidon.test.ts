import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { createPgKnowledgeSearchIndex } from "./knowledge-search.js";

const dialect = new PgDialect();

function fixture() {
  const execute = vi.fn(async (_query: SQL) => [
    { item_id: "item-1", slug: "guide", title: "Guide" },
  ]);
  const db = { execute } as unknown as Db;
  return { execute, index: createPgKnowledgeSearchIndex(db) };
}

describe("PostgreSQL knowledge search scope", () => {
  it.each(["", "   ", "\t\t", "\n\r\n"])(
    "returns no results and does not execute for blank query %j",
    async (query) => {
      const { execute, index } = fixture();
      expect(await index.search("nest-a", query, 5)).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(0);
    },
  );

  it("trims edges but preserves internal whitespace in every query binding", async () => {
    const { execute, index } = fixture();
    expect(await index.search("nest-a", " \talpha  beta\n ", 5)).toEqual([
      { itemId: "item-1", slug: "guide", title: "Guide" },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const rendered = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(rendered.params).toEqual([
      "alpha  beta", "nest-a", "alpha  beta", "alpha  beta", "alpha  beta",
      "nest-a", "alpha  beta", "alpha  beta", "alpha  beta", 5,
    ]);
    expect(rendered.sql).not.toContain("alpha  beta");
  });

  it("preserves Unicode and quotes as data rather than interpolating SQL", async () => {
    const { execute, index } = fixture();
    const query = "caf\u00e9 'quoted' \"guide\"";
    expect(await index.search("nest-b", `  ${query}  `, 3)).toEqual([
      { itemId: "item-1", slug: "guide", title: "Guide" },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const rendered = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(rendered.params).toEqual([
      query, "nest-b", query, query, query, "nest-b", query, query, query, 3,
    ]);
    expect(rendered.sql).not.toContain(query);
  });

  it("binds each CTE to the current nest on consecutive searches", async () => {
    const { execute, index } = fixture();
    expect(await index.search("nest-first", " first ", 7)).toEqual([
      { itemId: "item-1", slug: "guide", title: "Guide" },
    ]);
    expect(await index.search("nest-second", " second ", 2)).toEqual([
      { itemId: "item-1", slug: "guide", title: "Guide" },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    const first = dialect.sqlToQuery(execute.mock.calls[0][0]);
    const second = dialect.sqlToQuery(execute.mock.calls[1][0]);
    for (const rendered of [first, second]) {
      expect(rendered.sql).toMatch(/with lex as \([\s\S]*?where "nest_id" = \$2[\s\S]*?\),\s*trg as \([\s\S]*?where "nest_id" = \$6/);
      expect(rendered.sql).toMatch(/limit \$10\s*$/);
    }
    expect(first.params).toEqual([
      "first", "nest-first", "first", "first", "first", "nest-first", "first", "first", "first", 7,
    ]);
    expect(second.params).toEqual([
      "second", "nest-second", "second", "second", "second", "nest-second", "second", "second", "second", 2,
    ]);
    expect(second.params).not.toContain("nest-first");
  });
});
