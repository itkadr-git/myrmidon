import { describe, expect, it, vi } from "vitest";
import { createAdmKnowledgeAdapter, type AdmKnowledgeItem, type AdmKnowledgeRestPort } from "./adm-knowledge-adapter.js";

const spaces = [
  ["policy", "rule"],
  ["trigger", "rule"],
  ["reference", "wiki"],
  ["skills", "skill_card"],
  ["lessons", "wiki"],
] as const;

function item(space: string, kind: string, status = "published"): AdmKnowledgeItem {
  return Object.freeze({ id: `stable-${space}`, slug: `adm/${space}/example`, kind, title: "Example", summary: "Summary", status, updatedAt: "2026-10-25T00:00:00.000Z", deliveredRevisionId: `revision-${space}` });
}

function port(overrides: Partial<AdmKnowledgeRestPort> = {}) {
  return {
    search: vi.fn<AdmKnowledgeRestPort["search"]>(async () => []),
    list: vi.fn<AdmKnowledgeRestPort["list"]>(async () => []),
    read: vi.fn<AdmKnowledgeRestPort["read"]>(async () => null),
    ...overrides,
  };
}

describe("ADM knowledge read namespace isolation", () => {
  describe.each(spaces)("%s namespace", (space, kind) => {
    it("searches the exact namespace and filters foreign and unpublished records", async () => {
      const published = item(space, kind);
      const fixtures = Object.freeze([published, item("foreign", kind), ...["draft", "proposed", "archived"].map((status) => item(space, kind, status))]);
      const api = port({ search: vi.fn(async () => fixtures) });
      const adapter = createAdmKnowledgeAdapter(api);
      await expect(adapter.search("  deploy safety  ", space, 7)).resolves.toEqual([published]);
      await expect(adapter.search("deploy", space)).resolves.toEqual([published]);
      expect(api.search).toHaveBeenCalledTimes(2);
      expect(api.search).toHaveBeenNthCalledWith(1, "  deploy safety  ", { space: `adm/${space}/`, limit: 7 });
      expect(api.search).toHaveBeenNthCalledWith(2, "deploy", { space: `adm/${space}/`, limit: 50 });
      expect(fixtures.map((entry) => entry.status)).toEqual(["published", "published", "draft", "proposed", "archived"]);
    });

    it("rejects search results with the right prefix and wrong kind", async () => {
      const api = port({ search: vi.fn(async () => Object.freeze([item(space, "wrong")])) });
      await expect(createAdmKnowledgeAdapter(api).search("query", space)).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
      expect(api.search).toHaveBeenCalledTimes(1);
    });

    it("lists with exact scope and preserves the port result", async () => {
      const published = item(space, kind);
      const fixtures = Object.freeze([published]);
      const api = port({ list: vi.fn(async () => fixtures) });
      const adapter = createAdmKnowledgeAdapter(api);
      await expect(adapter.list(space, 9)).resolves.toEqual([published]);
      await expect(adapter.list(space)).resolves.toEqual([published]);
      expect(api.list).toHaveBeenCalledTimes(2);
      expect(api.list).toHaveBeenNthCalledWith(1, { space: `adm/${space}/`, kind, status: "published", limit: 9 });
      expect(api.list).toHaveBeenNthCalledWith(2, { space: `adm/${space}/`, kind, status: "published", limit: 100 });
    });

    it.each(["prefix", "kind"])("rejects list records with incorrect %s", async (invalid) => {
      const api = port({ list: vi.fn(async () => Object.freeze([invalid === "prefix" ? item("foreign", kind) : item(space, "wrong")])) });
      await expect(createAdmKnowledgeAdapter(api).list(space)).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    it("reads published records by stable ID without losing revision", async () => {
      const published = item(space, kind);
      const api = port({ read: vi.fn(async () => published) });
      await expect(createAdmKnowledgeAdapter(api).read(published.id)).resolves.toEqual(published);
      expect(api.read).toHaveBeenCalledOnce();
      expect(api.read).toHaveBeenCalledWith(published.id);
      expect(published.deliveredRevisionId).toBe(`revision-${space}`);
    });

    it("rejects reads with an incorrect kind", async () => {
      const api = port({ read: vi.fn(async () => item(space, "wrong")) });
      await expect(createAdmKnowledgeAdapter(api).read("stable-id")).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
      expect(api.read).toHaveBeenCalledExactlyOnceWith("stable-id");
    });
  });

  it.each(["", " \t\n "])("rejects empty search %j before calling the port", async (query) => {
    const api = port();
    await expect(createAdmKnowledgeAdapter(api).search(query, "policy")).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
    expect(api.search).not.toHaveBeenCalled();
  });

  it.each([null, "draft", "proposed", "archived"])("returns not found for read result %s", async (status) => {
    const api = port({ read: vi.fn(async () => status === null ? null : item("policy", "rule", status)) });
    await expect(createAdmKnowledgeAdapter(api).read("stable-id")).rejects.toMatchObject({ code: "ADM_NOT_FOUND" });
    expect(api.read).toHaveBeenCalledExactlyOnceWith("stable-id");
  });

  it("rejects a read outside ADM", async () => {
    const foreign = Object.freeze({ ...item("policy", "rule"), slug: "other/policy/example" });
    const api = port({ read: vi.fn(async () => foreign) });
    await expect(createAdmKnowledgeAdapter(api).read("stable-id")).rejects.toMatchObject({ code: "ADM_INVALID_METADATA" });
    expect(api.read).toHaveBeenCalledExactlyOnceWith("stable-id");
  });
});
