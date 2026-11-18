import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { createPgKnowledgeSearchIndex } from "./knowledge-search.js";

const rowA = { item_id: "item-a", slug: "alpha", title: "Alpha", rank: 0.2 };
const rowB = { item_id: "item-b", slug: "bravo", title: "Bravo", rank: 0.9 };
const rowC = { item_id: "item-c", slug: "charlie", title: "Charlie", rank: 0.5 };

type Row = typeof rowA;

function fixture(...responses: Row[][]) {
  const execute = vi.fn<(query: Parameters<Db["execute"]>[0]) => Promise<Row[]>>();
  for (const rows of responses) execute.mockResolvedValueOnce(rows);
  const port: Pick<Db, "execute"> = { execute: (query) => execute(query) as never };
  return { execute, index: createPgKnowledgeSearchIndex(port as Db) };
}

describe("PostgreSQL knowledge search result projection", () => {
  it("returns an empty result from zero rows", async () => {
    const { execute, index } = fixture([]);
    expect(await index.search("nest-a", "term", 5)).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("projects a single row without exposing rank", async () => {
    const { execute, index } = fixture([rowA]);
    expect(await index.search("nest-a", "term", 5)).toEqual([
      { itemId: "item-a", slug: "alpha", title: "Alpha" },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls[0]?.[0];
    expect(query).toBeDefined();
    if (!query || typeof query === "string") throw new Error("Expected a SQL query");
    const rendered = new PgDialect().sqlToQuery(query.getSQL());
    expect(rendered.sql).toContain('select "id" as "item_id", "slug", "title"');
    expect(rendered.params).toEqual(["term", "nest-a", "term", "term", "term", "nest-a", "term", "term", "term", 5]);
  });

  it("preserves the database order for three distinct rows", async () => {
    const { execute, index } = fixture([rowB, rowA, rowC]);
    expect(await index.search("nest-a", "term", 3)).toEqual([
      { itemId: "item-b", slug: "bravo", title: "Bravo" },
      { itemId: "item-a", slug: "alpha", title: "Alpha" },
      { itemId: "item-c", slug: "charlie", title: "Charlie" },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("projects successive responses independently", async () => {
    const { execute, index } = fixture([rowA], [rowB, rowC]);
    expect(await index.search("nest-a", "first", 1)).toEqual([
      { itemId: "item-a", slug: "alpha", title: "Alpha" },
    ]);
    expect(await index.search("nest-a", "second", 2)).toEqual([
      { itemId: "item-b", slug: "bravo", title: "Bravo" },
      { itemId: "item-c", slug: "charlie", title: "Charlie" },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not share responses between indexes", async () => {
    const first = fixture([rowA]);
    const second = fixture([rowB]);
    expect(await second.index.search("nest-a", "term", 5)).toEqual([
      { itemId: "item-b", slug: "bravo", title: "Bravo" },
    ]);
    expect(await first.index.search("nest-a", "term", 5)).toEqual([
      { itemId: "item-a", slug: "alpha", title: "Alpha" },
    ]);
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).toHaveBeenCalledTimes(1);
  });

  it("does not cache an empty response", async () => {
    const { execute, index } = fixture([], [rowC]);
    expect(await index.search("nest-a", "term", 5)).toEqual([]);
    expect(await index.search("nest-a", "term", 5)).toEqual([
      { itemId: "item-c", slug: "charlie", title: "Charlie" },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not let callers mutate later results or fixture rows", async () => {
    const rows = [{ ...rowA }];
    const { execute, index } = fixture(rows, rows);
    const result = await index.search("nest-a", "term", 5);
    expect(result).toEqual([{ itemId: "item-a", slug: "alpha", title: "Alpha" }]);
    result[0].title = "Changed";
    result.push({ itemId: "extra", slug: "extra", title: "Extra" });
    expect(await index.search("nest-a", "term", 5)).toEqual([
      { itemId: "item-a", slug: "alpha", title: "Alpha" },
    ]);
    expect(rows).toEqual([{ item_id: "item-a", slug: "alpha", title: "Alpha", rank: 0.2 }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
