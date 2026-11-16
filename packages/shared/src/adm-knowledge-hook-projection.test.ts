import { describe, expect, it, vi } from "vitest";
import { createAdmKnowledgeAdapter, type AdmKnowledgeItem, type AdmKnowledgeRestPort } from "./adm-knowledge-adapter.js";

const item: AdmKnowledgeItem = {
  id: "policy-1", slug: "adm/policy/deploy", kind: "rule", title: "Deploy",
  summary: "Deploy safely", status: "published", updatedAt: "2026-10-25T00:00:00.000Z",
  body: "Private body", content: "Fallback content", triggers: ["deploy", "release"], priority: 7,
};

function setup(items: AdmKnowledgeItem[] = [item]) {
  const rest: AdmKnowledgeRestPort = {
    list: vi.fn(async () => items),
    search: vi.fn(async () => []),
    read: vi.fn(async () => null),
  };
  return { rest, load: createAdmKnowledgeAdapter(rest).createHookLoader() };
}

describe("ADM hook loader projection", () => {
  it("requests the exact published ADM listing", async () => {
    const { rest, load } = setup();
    expect((await load()).items.map((entry) => entry.id)).toEqual(["policy-1"]);
    expect(rest.list).toHaveBeenCalledOnce();
    expect(rest.list).toHaveBeenCalledWith({ space: "adm/", status: "published", limit: 100 });
  });

  it.each([
    ["foreign prefix", "other/policy/deploy", "published"],
    ["similar prefix", "administrator/policy/deploy", "published"],
    ["draft", "adm/policy/deploy", "draft"],
    ["proposed", "adm/policy/deploy", "proposed"],
    ["archived", "adm/policy/deploy", "archived"],
  ])("excludes %s while retaining published ADM items", async (_name, slug, status) => {
    const { load } = setup([item, { ...item, id: "excluded", slug, status }]);
    expect((await load()).items.map((entry) => entry.id)).toEqual(["policy-1"]);
  });

  it.each([
    ["no arguments", undefined, ""],
    ["session with match", { event: "SessionStart" as const, triggers: ["deploy"] }, ""],
    ["session without match", { event: "SessionStart" as const, triggers: ["other"] }, ""],
    ["prompt without triggers", { event: "UserPromptSubmit" as const }, ""],
    ["prompt with empty triggers", { event: "UserPromptSubmit" as const, triggers: [] }, ""],
    ["prompt without match", { event: "UserPromptSubmit" as const, triggers: ["other"] }, ""],
    ["prompt first match", { event: "UserPromptSubmit" as const, triggers: ["deploy", "other"] }, "Private body"],
    ["prompt later match", { event: "UserPromptSubmit" as const, triggers: ["other", "release"] }, "Private body"],
    ["no event with match", { triggers: ["deploy"] }, ""],
  ])("projects body for %s", async (_name, args, body) => {
    const { load } = setup();
    const result = await load(args);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.body).toBe(body);
  });

  it("uses content only when a matching item's body is absent", async () => {
    const { load } = setup([{ ...item, body: undefined }]);
    expect((await load({ event: "UserPromptSubmit", triggers: ["deploy"] })).items[0]?.body).toBe("Fallback content");
    expect((await load({ event: "SessionStart", triggers: ["deploy"] })).items[0]?.body).toBe("");
  });

  it("uses an empty body when neither body nor content exists", async () => {
    const { load } = setup([{ ...item, body: undefined, content: undefined }]);
    expect((await load({ event: "UserPromptSubmit", triggers: ["deploy"] })).items[0]?.body).toBe("");
  });

  it("prefers explicit triggers over tags for disclosure", async () => {
    const { load } = setup([{ ...item, triggers: ["release"], tags: ["trigger:deploy"] }]);
    const denied = (await load({ event: "UserPromptSubmit", triggers: ["deploy"] })).items[0];
    expect(denied?.triggers).toEqual(["release"]);
    expect(denied?.body).toBe("");
    expect((await load({ event: "UserPromptSubmit", triggers: ["release"] })).items[0]?.body).toBe("Private body");
  });

  it("treats explicit empty triggers as authoritative", async () => {
    const { load } = setup([{ ...item, triggers: [], tags: ["trigger:deploy"] }]);
    const projected = (await load({ event: "UserPromptSubmit", triggers: ["deploy"] })).items[0];
    expect(projected?.triggers).toEqual([]);
    expect(projected?.body).toBe("");
  });

  it("normalizes tag triggers without mutating the source", async () => {
    const source = { ...item, triggers: undefined, tags: ["trigger:deploy", "release"] };
    const before = structuredClone(source);
    const { load } = setup([source]);
    const projected = (await load({ event: "UserPromptSubmit", triggers: ["deploy"] })).items[0];
    expect(projected?.triggers).toEqual(["deploy", "release"]);
    expect(projected?.body).toBe("Private body");
    expect(source).toEqual(before);
  });

  it("defaults missing summary and priority without mutating the source", async () => {
    const source = { ...item, summary: null, priority: undefined };
    const before = structuredClone(source);
    const { load } = setup([source]);
    expect((await load()).items[0]).toMatchObject({ id: item.id, summary: "", priority: 0 });
    expect(source).toEqual(before);
  });
});
