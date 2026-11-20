import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { createPgKnowledgeSearchIndex } from "./knowledge-search.js";

const page = {
  itemId: "item-1", nestId: "nest-1", slug: "guide", title: "Guide",
  summary: null, content: "Delivered content",
};
const row = { item_id: "item-1", slug: "guide", title: "Guide" };
const hit = { itemId: "item-1", slug: "guide", title: "Guide" };
const dialect = new PgDialect();

function fixture() {
  const execute = vi.fn();
  const port: Pick<Db, "execute"> = { execute };
  const index = createPgKnowledgeSearchIndex(port as Db);
  function queryAt(call: number) {
    expect(execute.mock.calls[call]).toHaveLength(1);
    return dialect.sqlToQuery(execute.mock.calls[call][0] as SQL);
  }
  return { execute, index, queryAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("PostgreSQL knowledge search port failures", () => {
  it("propagates an upsert rejection once and accepts the next write", async () => {
    const { execute, index, queryAt } = fixture();
    const sentinel = new Error("upsert failed");
    execute.mockRejectedValueOnce(sentinel).mockResolvedValueOnce([]);
    await expect(index.upsert(page)).rejects.toBe(sentinel);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queryAt(0).sql).toMatch(/insert into "knowledge_search"/i);
    expect(queryAt(0).params).toEqual(["item-1", "nest-1", "guide", "Guide", null, "Delivered content"]);
    await expect(index.upsert(page)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queryAt(1)).toEqual(queryAt(0));
  });

  it("propagates a remove rejection once and accepts the next delete", async () => {
    const { execute, index, queryAt } = fixture();
    const sentinel = new Error("remove failed");
    execute.mockRejectedValueOnce(sentinel).mockResolvedValueOnce([]);
    await expect(index.remove("item-1")).rejects.toBe(sentinel);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queryAt(0).sql).toMatch(/delete from "knowledge_search"/i);
    expect(queryAt(0).params).toEqual(["item-1"]);
    await expect(index.remove("item-1")).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queryAt(1)).toEqual(queryAt(0));
  });

  it("propagates a search rejection once and returns hits on the next read", async () => {
    const { execute, index, queryAt } = fixture();
    const sentinel = new Error("search failed");
    execute.mockRejectedValueOnce(sentinel).mockResolvedValueOnce([row]);
    await expect(index.search("nest-1", "guide", 3)).rejects.toBe(sentinel);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queryAt(0).sql).toMatch(/from "knowledge_search"/i);
    await expect(index.search("nest-1", "guide", 3)).resolves.toEqual([hit]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queryAt(1)).toEqual(queryAt(0));
  });

  it("returns no hits for an empty query without calling a failing port", async () => {
    const { execute, index } = fixture();
    execute.mockRejectedValue(new Error("must not execute"));
    await expect(index.search("nest-1", " \t\n", 3)).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("waits for an upsert to resolve", async () => {
    const { execute, index } = fixture();
    const pending = deferred<unknown[]>();
    execute.mockReturnValueOnce(pending.promise);
    let settled = false;
    const result = index.upsert(page).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await expect(result).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("waits for a remove rejection", async () => {
    const { execute, index } = fixture();
    const pending = deferred<unknown[]>();
    const sentinel = new Error("deferred delete failure");
    execute.mockReturnValueOnce(pending.promise);
    let settled = false;
    const result = index.remove("item-1").finally(() => { settled = true; });
    const assertion = expect(result).rejects.toBe(sentinel);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    pending.reject(sentinel);
    await assertion;
    expect(settled).toBe(true);
  });

  it("waits for the search rows before returning hits", async () => {
    const { execute, index } = fixture();
    const pending = deferred<unknown[]>();
    execute.mockReturnValueOnce(pending.promise);
    let settled = false;
    const result = index.search("nest-1", "guide", 3).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve([row]);
    await expect(result).resolves.toEqual([hit]);
    expect(settled).toBe(true);
  });
});
