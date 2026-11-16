import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createKnowledgeModule } from "./service.js";

const ports = vi.hoisted(() => ({
  createService: vi.fn(),
  createIndex: vi.fn(),
  redact: vi.fn(),
}));

vi.mock("./store.js", () => ({ createKnowledgeService: ports.createService }));
vi.mock("../redact/service.js", () => ({ redactNestText: ports.redact }));
vi.mock("@myrmidon/db", () => ({ createPgKnowledgeSearchIndex: ports.createIndex }));

const db = {} as Db;
const company = "company-a";
const nest = "nest-a";

function makeStore() {
  return {
    get: vi.fn(),
    getRevision: vi.fn(),
    listRevisions: vi.fn(),
    listItems: vi.fn(),
    backlinks: vi.fn(),
    listEvents: vi.fn(),
    search: vi.fn(),
  };
}

function setup(nestId = nest) {
  const store = makeStore();
  ports.createService.mockReturnValueOnce(store);
  const module = createKnowledgeModule(db, company, { nestId });
  return { store, module };
}

beforeEach(() => {
  vi.resetAllMocks();
  ports.createIndex.mockReturnValue({});
});

describe("knowledge module read scope", () => {
  it("binds get to a custom nest and preserves language and result identity", async () => {
    const { store, module } = setup();
    const result = { id: "item-a" };
    store.get.mockResolvedValue(result);
    expect(await module.get("guide/a", "en")).toBe(result);
    expect(store.get).toHaveBeenCalledExactlyOnceWith("nest-a", "guide/a", "en");
    expect(store.get).not.toHaveBeenCalledWith(company, "guide/a", "en");
  });

  it("passes revision IDs to getRevision", async () => {
    const { store, module } = setup();
    const result = { id: "revision-a" };
    store.getRevision.mockResolvedValue(result);
    expect(await module.getRevision("guide/a", "revision-a")).toBe(result);
    expect(store.getRevision).toHaveBeenCalledExactlyOnceWith("nest-a", "guide/a", "revision-a");
  });

  it("passes language to listRevisions without reconstructing the result", async () => {
    const { store, module } = setup();
    const result = [{ id: "revision-a" }];
    store.listRevisions.mockResolvedValue(result);
    expect(await module.listRevisions("guide/a", "ru")).toBe(result);
    expect(store.listRevisions).toHaveBeenCalledExactlyOnceWith("nest-a", "guide/a", "ru");
  });

  it("passes the filter object to listItems", async () => {
    const { store, module } = setup();
    const filter = { status: "published" as const, folderPrefix: "guide" };
    const result = [{ id: "item-a" }];
    store.listItems.mockResolvedValue(result);
    expect(await module.listItems(filter)).toBe(result);
    expect(store.listItems).toHaveBeenCalledExactlyOnceWith("nest-a", filter);
  });

  it("passes the slug to backlinks", async () => {
    const { store, module } = setup();
    const result = [{ sourceSlug: "guide/b" }];
    store.backlinks.mockResolvedValue(result);
    expect(await module.backlinks("guide/a")).toBe(result);
    expect(store.backlinks).toHaveBeenCalledExactlyOnceWith("nest-a", "guide/a");
  });

  it("passes the item ID and limit to listEvents", async () => {
    const { store, module } = setup();
    const result = [{ id: "event-a" }];
    store.listEvents.mockResolvedValue(result);
    expect(await module.listEvents("item-a", 7)).toBe(result);
    expect(store.listEvents).toHaveBeenCalledExactlyOnceWith("nest-a", "item-a", 7);
  });

  it("passes query, limit and language to search", async () => {
    const { store, module } = setup();
    const result = [{ itemId: "item-a", slug: "guide/a", title: "A" }];
    store.search.mockResolvedValue(result);
    expect(await module.search("needle", 3, "en")).toBe(result);
    expect(store.search).toHaveBeenCalledExactlyOnceWith("nest-a", "needle", 3, "en");
  });

  it("leaves omitted optional arguments undefined", async () => {
    const { store, module } = setup();
    await module.get("guide/a");
    await module.listRevisions("guide/a");
    await module.listItems();
    await module.listEvents();
    await module.search("needle");
    expect(store.get).toHaveBeenCalledExactlyOnceWith("nest-a", "guide/a", undefined);
    expect(store.listRevisions).toHaveBeenCalledExactlyOnceWith("nest-a", "guide/a", undefined);
    expect(store.listItems).toHaveBeenCalledExactlyOnceWith("nest-a", undefined);
    expect(store.listEvents).toHaveBeenCalledExactlyOnceWith("nest-a", undefined, undefined);
    expect(store.search).toHaveBeenCalledExactlyOnceWith("nest-a", "needle", undefined, undefined);
  });

  it("defaults nest to company when no override is supplied", async () => {
    const store = makeStore();
    ports.createService.mockReturnValueOnce(store);
    const module = createKnowledgeModule(db, company);
    const result = { id: "default-item" };
    store.get.mockResolvedValue(result);
    expect(module.nestId).toBe(company);
    expect(await module.get("guide/default")).toBe(result);
    expect(store.get).toHaveBeenCalledExactlyOnceWith("company-a", "guide/default", undefined);
  });

  it("keeps two modules and their stores isolated", async () => {
    const first = setup("nest-a");
    const second = setup("nest-b");
    const a = [{ id: "a" }];
    const b = [{ id: "b" }];
    first.store.listItems.mockResolvedValue(a);
    second.store.listItems.mockResolvedValue(b);
    expect(await first.module.listItems()).toBe(a);
    expect(await second.module.listItems()).toBe(b);
    expect(first.store.listItems).toHaveBeenCalledExactlyOnceWith("nest-a", undefined);
    expect(second.store.listItems).toHaveBeenCalledExactlyOnceWith("nest-b", undefined);
    expect(ports.createService).toHaveBeenCalledTimes(2);
  });

  it("propagates read errors instead of returning an empty list", async () => {
    const { store, module } = setup();
    const error = new Error("store failure");
    store.search.mockRejectedValue(error);
    await expect(module.search("needle")).rejects.toBe(error);
    expect(store.search).toHaveBeenCalledExactlyOnceWith("nest-a", "needle", undefined, undefined);
  });
});
