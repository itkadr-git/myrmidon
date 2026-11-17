import { PgDialect } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import { PgRaw } from "drizzle-orm/pg-core/query-builders/raw";
import type { RowList } from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { createPgKnowledgeSearchIndex } from "./knowledge-search.js";

const dialect = new PgDialect();

function renderedQuery(query: Parameters<Db["execute"]>[0]) {
  if (!(query instanceof SQL)) throw new Error("Expected SQL query");
  return dialect.sqlToQuery(query);
}

function fixture() {
  const execute = vi.fn((_query: Parameters<Db["execute"]>[0]) => {});
  const rows = [{ item_id: "item-1", slug: "guide", title: "Guide" }];
  const port: Pick<Db, "execute"> = {
    execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
      query: Parameters<Db["execute"]>[0],
    ): PgRaw<RowList<TRow[]>> {
      execute(query);
      const statement = typeof query === "string" ? sql.raw(query) : query.getSQL();
      return new PgRaw<RowList<TRow[]>>(
        // Fixed driver rows omit metadata; this adapter only awaits and maps them.
        async () => rows as unknown as RowList<TRow[]>,
        statement,
        dialect.sqlToQuery(statement),
        (result) => result,
      );
    },
  };
  return { execute, index: createPgKnowledgeSearchIndex(port as Db) };
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
    const rendered = renderedQuery(execute.mock.calls[0][0]);
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
    const rendered = renderedQuery(execute.mock.calls[0][0]);
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
    const first = renderedQuery(execute.mock.calls[0][0]);
    const second = renderedQuery(execute.mock.calls[1][0]);
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
