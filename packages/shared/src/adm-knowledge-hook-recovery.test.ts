import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmKnowledgeAdapter, type AdmKnowledgeItem, type AdmKnowledgeRestPort } from "./adm-knowledge-adapter.js";

const now = new Date("2026-11-16T12:34:56.000Z");
const item: AdmKnowledgeItem = {
  id: "first", slug: "adm/policy/example", kind: "rule", title: "Example",
  summary: "Example", status: "published", updatedAt: "2026-01-01T00:00:00.000Z",
};

function loaderFor(list: AdmKnowledgeRestPort["list"]) {
  const rest: AdmKnowledgeRestPort = { list, search: vi.fn(), read: vi.fn() };
  return createAdmKnowledgeAdapter(rest).createHookLoader();
}

describe("ADM knowledge hook recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it("marks a populated response fresh at the current time", async () => {
    const result = await loaderFor(vi.fn().mockResolvedValue([item]))();
    expect(result).toMatchObject({ fetchedAt: now.getTime(), degraded: false, items: [{ id: "first" }] });
    expect(result.items).toHaveLength(1);
  });

  it("marks an empty upstream response fresh rather than degraded", async () => {
    await expect(loaderFor(vi.fn().mockResolvedValue([]))()).resolves.toEqual({ items: [], fetchedAt: now.getTime(), degraded: false });
  });

  it.each([
    ["Error", new Error("offline")],
    ["plain object", { status: 503 }],
    ["null", null],
  ])("returns the exact degraded envelope for %s rejection", async (_name, reason) => {
    await expect(loaderFor(vi.fn().mockRejectedValue(reason))()).resolves.toEqual({ items: [], fetchedAt: 0, degraded: true });
  });

  it("recovers on the same loader without reusing stale items", async () => {
    const list = vi.fn().mockResolvedValueOnce([item]).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([{ ...item, id: "second" }]);
    const load = loaderFor(list);
    expect((await load()).items.map((entry) => entry.id)).toEqual(["first"]);
    expect(await load()).toEqual({ items: [], fetchedAt: 0, degraded: true });
    vi.setSystemTime(new Date(now.getTime() + 1000));
    const recovered = await load();
    expect(recovered).toMatchObject({ fetchedAt: now.getTime() + 1000, degraded: false });
    expect(recovered.items.map((entry) => entry.id)).toEqual(["second"]);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["delivered first", { deliveredRevisionId: "delivered", revisionId: "camel", revision_id: "snake" }, "delivered"],
    ["camel before snake", { deliveredRevisionId: null, revisionId: "camel", revision_id: "snake" }, "camel"],
    ["snake fallback", { deliveredRevisionId: null, revisionId: null, revision_id: "snake" }, "snake"],
    ["missing revisions", {}, ""],
    ["all null revisions", { deliveredRevisionId: null, revisionId: null, revision_id: null }, ""],
    ["empty delivered wins", { deliveredRevisionId: "", revisionId: "camel", revision_id: "snake" }, ""],
    ["empty camel wins", { deliveredRevisionId: null, revisionId: "", revision_id: "snake" }, ""],
    ["empty snake survives", { revision_id: "" }, ""],
  ])("selects revision: %s", async (_name, revisions, expected) => {
    const result = await loaderFor(vi.fn().mockResolvedValue([{ ...item, ...revisions }]))();
    expect(result.degraded).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.revision_id).toBe(expected);
  });

  it("preserves the upstream updatedAt", async () => {
    const result = await loaderFor(vi.fn().mockResolvedValue([item]))();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.updated_at).toBe(item.updatedAt);
  });

  it.each([[undefined], [null]])("uses the current system time when updatedAt is %s", async (updatedAt) => {
    const result = await loaderFor(vi.fn().mockResolvedValue([{ ...item, updatedAt }]))();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.updated_at).toBe(now.toISOString());
  });
});
