import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import type { DraftKnowledgeInput, KnowledgeActor } from "./store.js";
import { createKnowledgeModule } from "./service.js";

const ports = vi.hoisted(() => ({
  draft: vi.fn(),
  redact: vi.fn(),
  createStore: vi.fn(),
  createIndex: vi.fn(),
}));

vi.mock("./store.js", () => ({ createKnowledgeService: ports.createStore }));
vi.mock("../redact/service.js", () => ({ redactNestText: ports.redact }));
vi.mock("@myrmidon/db", () => ({ createPgKnowledgeSearchIndex: ports.createIndex }));

const db = {} as Db;
const companyId = "company-a";
const actor: KnowledgeActor = { actorType: "agent", actorId: "agent-a", kind: "engineer" };
const result = { id: "item-result" };

beforeEach(() => {
  vi.resetAllMocks();
  ports.createStore.mockReturnValue({ draft: ports.draft });
  ports.createIndex.mockReturnValue({ name: "index" });
  ports.draft.mockResolvedValue(result);
  ports.redact.mockResolvedValue({ text: "safe content" });
});

describe("knowledge module draft redaction composition", () => {
  const cases: Array<{ name: string; input: DraftKnowledgeInput; expected: DraftKnowledgeInput }> = [
    { name: "minimal input", input: { content: "raw content" }, expected: { content: "safe content" } },
    { name: "submission", input: { content: "raw content", submit: true }, expected: { content: "safe content", submit: true } },
    { name: "title and summary", input: { content: "raw content", title: "Title", summary: "Summary" }, expected: { content: "safe content", title: "Title", summary: "Summary" } },
    { name: "sources", input: { content: "raw content", sources: [{ kind: "task", ref: "task-a", note: "note" }] }, expected: { content: "safe content", sources: [{ kind: "task", ref: "task-a", note: "note" }] } },
    { name: "language and translation", input: { content: "raw content", lang: "en", translationOf: "revision-a" }, expected: { content: "safe content", lang: "en", translationOf: "revision-a" } },
    { name: "force and reason", input: { content: "raw content", force: true, reason: "reason-a" }, expected: { content: "safe content", force: true, reason: "reason-a" } },
    { name: "explicit false and null values", input: { content: "raw content", submit: false, force: false, summary: null, reason: null, translationOf: null }, expected: { content: "safe content", submit: false, force: false, summary: null, reason: null, translationOf: null } },
    { name: "change summary", input: { content: "raw content", changeSummary: "change-a" }, expected: { content: "safe content", changeSummary: "change-a" } },
  ];

  it.each(cases)("passes $name with the default nest and redacted content", async ({ input, expected }) => {
    const module = createKnowledgeModule(db, companyId);
    const output = await module.draft("item/slug", input, actor);
    expect(output).toBe(result);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, companyId, "raw content");
    expect(ports.draft).toHaveBeenCalledTimes(1);
    expect(ports.draft).toHaveBeenCalledWith(companyId, "item/slug", expected, actor);
    expect(input.content).toBe("raw content");
  });

  it("uses the custom nest for both ports instead of the company", async () => {
    const module = createKnowledgeModule(db, companyId, { nestId: "nest-b" });
    await expect(module.draft("item-id", { content: "raw content" }, actor)).resolves.toBe(result);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "nest-b", "raw content");
    expect(ports.redact).not.toHaveBeenCalledWith(db, companyId, "raw content");
    expect(ports.draft).toHaveBeenCalledTimes(1);
    expect(ports.draft).toHaveBeenCalledWith("nest-b", "item-id", { content: "safe content" }, actor);
  });

  it("does not draft when redaction rejects", async () => {
    const error = new Error("redaction failed");
    ports.redact.mockRejectedValue(error);
    const module = createKnowledgeModule(db, companyId);
    await expect(module.draft("item-id", { content: "raw content" }, actor)).rejects.toBe(error);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, companyId, "raw content");
    expect(ports.draft).not.toHaveBeenCalled();
  });

  it("propagates a draft rejection after redaction", async () => {
    const error = new Error("draft failed");
    ports.draft.mockRejectedValue(error);
    const module = createKnowledgeModule(db, companyId);
    await expect(module.draft("item-id", { content: "raw content" }, actor)).rejects.toBe(error);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, companyId, "raw content");
    expect(ports.draft).toHaveBeenCalledTimes(1);
    expect(ports.draft).toHaveBeenCalledWith(companyId, "item-id", { content: "safe content" }, actor);
  });

  it("uses each successive redaction result, including an empty result", async () => {
    ports.redact.mockResolvedValueOnce({ text: "first safe" }).mockResolvedValueOnce({ text: "" });
    const module = createKnowledgeModule(db, companyId);
    await expect(module.draft("first", { content: "first raw" }, actor)).resolves.toBe(result);
    await expect(module.draft("second", { content: "second raw" }, actor)).resolves.toBe(result);
    expect(ports.redact).toHaveBeenCalledTimes(2);
    expect(ports.redact).toHaveBeenNthCalledWith(1, db, companyId, "first raw");
    expect(ports.redact).toHaveBeenNthCalledWith(2, db, companyId, "second raw");
    expect(ports.draft).toHaveBeenCalledTimes(2);
    expect(ports.draft).toHaveBeenNthCalledWith(1, companyId, "first", { content: "first safe" }, actor);
    expect(ports.draft).toHaveBeenNthCalledWith(2, companyId, "second", { content: "" }, actor);
  });
});
