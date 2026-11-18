import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { createPgKnowledgeSearchIndex } from "./knowledge-search.js";

const first = {
  itemId: "item-first",
  nestId: "nest-first",
  slug: "slug' OR 1=1 --",
  title: "Title 'quoted'; DROP TABLE knowledge_search; --",
  summary: null,
  content: "Knowledge: \u041f\u0440\u0438\u0432\u0435\u0442 \u4e16\u754c",
};
const second = {
  itemId: "item-second",
  nestId: "nest-second",
  slug: "second-'slug",
  title: "Second 'title'",
  summary: "A delivered summary",
  content: "Another \u00e9l\u00e8ve \ud83d\ude80",
};

function fixture() {
  const execute = vi.fn();
  const db: Pick<Db, "execute"> = { execute };
  return { execute, index: createPgKnowledgeSearchIndex(db as Db) };
}

function render(execute: ReturnType<typeof fixture>["execute"], call: number) {
  const args = execute.mock.calls[call];
  expect(args).toHaveLength(1);
  const statement: unknown = args?.[0];
  expect(statement).toBeInstanceOf(SQL);
  if (!(statement instanceof SQL)) throw new Error("Expected SQL statement");
  return new PgDialect().sqlToQuery(statement);
}

describe("PostgreSQL knowledge search index write bindings", () => {
  it("binds all six delivered fields including a null summary", async () => {
    const { execute, index } = fixture();
    expect(await index.upsert(first)).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(render(execute, 0).params).toEqual([
      "item-first", "nest-first", "slug' OR 1=1 --",
      "Title 'quoted'; DROP TABLE knowledge_search; --", null, "Knowledge: \u041f\u0440\u0438\u0432\u0435\u0442 \u4e16\u754c",
    ]);
  });

  it("binds a nonempty summary and Unicode content in field order", async () => {
    const { execute, index } = fixture();
    expect(await index.upsert(second)).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(render(execute, 0).params).toEqual([
      "item-second", "nest-second", "second-'slug", "Second 'title'",
      "A delivered summary", "Another \u00e9l\u00e8ve \ud83d\ude80",
    ]);
  });

  it("inserts the six columns using placeholders instead of interpolating data", async () => {
    const { execute, index } = fixture();
    await index.upsert(first);
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql, params } = render(execute, 0);
    expect(sql).toMatch(/insert into "knowledge_search"\s*\("item_id", "nest_id", "slug", "title", "summary", "body"\)\s*values\s*\(\$1, \$2, \$3, \$4, \$5, \$6\)/i);
    expect(params).toHaveLength(6);
    for (const value of [first.itemId, first.nestId, first.slug, first.title, first.content]) {
      expect(sql).not.toContain(value);
    }
  });

  it("updates every mutable delivered field on an item conflict", async () => {
    const { execute, index } = fixture();
    await index.upsert(second);
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql } = render(execute, 0);
    expect(sql).toMatch(/on conflict\s*\("item_id"\)\s*do update/i);
    expect(sql).toMatch(/set\s+"nest_id"\s*=\s*excluded\."nest_id"\s*,\s*"slug"\s*=\s*excluded\."slug"\s*,\s*"title"\s*=\s*excluded\."title"\s*,\s*"summary"\s*=\s*excluded\."summary"\s*,\s*"body"\s*=\s*excluded\."body"/i);
  });

  it("removes by one bound item identifier without interpolating it", async () => {
    const { execute, index } = fixture();
    const itemId = "item' OR 1=1 --";
    expect(await index.remove(itemId)).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql, params } = render(execute, 0);
    expect(sql).toMatch(/^delete from "knowledge_search" where "item_id" = \$1$/i);
    expect(params).toEqual(["item' OR 1=1 --"]);
    expect(sql).not.toContain(itemId);
  });

  it("keeps consecutive upsert requests independent", async () => {
    const { execute, index } = fixture();
    await index.upsert(first);
    await index.upsert(second);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(render(execute, 0).params).toEqual([
      "item-first", "nest-first", "slug' OR 1=1 --", "Title 'quoted'; DROP TABLE knowledge_search; --", null, "Knowledge: \u041f\u0440\u0438\u0432\u0435\u0442 \u4e16\u754c",
    ]);
    expect(render(execute, 1).params).toEqual([
      "item-second", "nest-second", "second-'slug", "Second 'title'", "A delivered summary", "Another \u00e9l\u00e8ve \ud83d\ude80",
    ]);
    expect(execute.mock.calls[0]?.[0]).not.toBe(execute.mock.calls[1]?.[0]);
  });

  it("keeps consecutive remove requests independent", async () => {
    const { execute, index } = fixture();
    await index.remove("item-first");
    await index.remove("item-second");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(render(execute, 0).params).toEqual(["item-first"]);
    expect(render(execute, 1).params).toEqual(["item-second"]);
    expect(execute.mock.calls[0]?.[0]).not.toBe(execute.mock.calls[1]?.[0]);
  });
});
