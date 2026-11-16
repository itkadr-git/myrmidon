import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createKnowledgeModule } from "./service.js";

const ports = vi.hoisted(() => ({
  makeStore: vi.fn(),
  redact: vi.fn(),
  makeIndex: vi.fn(),
}));

vi.mock("./store.js", () => ({ createKnowledgeService: ports.makeStore }));
vi.mock("../redact/service.js", () => ({ redactNestText: ports.redact }));
vi.mock("@myrmidon/db", () => ({ createPgKnowledgeSearchIndex: ports.makeIndex }));

const db = {} as Db;
const actor = { actorType: "agent" as const, actorId: "agent-a", kind: "engineer" };
const input = {
  slug: "guide/example", title: "Example", content: "original content",
  lang: "en" as const, translationOf: null, kind: "wiki" as const,
  summary: "Summary", folderPath: "guide", tags: ["sample"], roles: ["reader"],
  approvalRequired: true, approverKind: "editor", sources: [{ kind: "document" as const, ref: "doc-a", note: "note" }],
  force: true, reason: "reason",
};
const stored = { id: "item-a", title: "Example" };
let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  create = vi.fn().mockResolvedValue(stored);
  ports.makeStore.mockReturnValue({ create });
  ports.makeIndex.mockReturnValue({ index: "default" });
  ports.redact.mockResolvedValue({ text: "redacted content", matches: [] });
});

describe("knowledge module create redaction composition", () => {
  it("uses the company as default nest and returns the store result", async () => {
    const mod = createKnowledgeModule(db, "company-a");
    expect(await mod.create(input, actor)).toBe(stored);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "company-a", "original content");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "redacted content", companyId: "company-a", nestId: "company-a" }, actor);
  });

  it("uses a custom nest for redaction and the store", async () => {
    const mod = createKnowledgeModule(db, "company-a", { nestId: "nest-a" });
    await mod.create(input, actor);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "nest-a", "original content");
    expect(ports.redact).not.toHaveBeenCalledWith(db, "company-a", "original content");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "redacted content", companyId: "company-a", nestId: "nest-a" }, actor);
  });

  it("waits for redaction before calling the store", async () => {
    let finish!: (value: { text: string }) => void;
    ports.redact.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const mod = createKnowledgeModule(db, "company-a");
    const pending = mod.create(input, actor);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    finish({ text: "safe later" });
    expect(await pending).toBe(stored);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "safe later", companyId: "company-a", nestId: "company-a" }, actor);
  });

  it("does not allow runtime scope fields to override module scope", async () => {
    const mod = createKnowledgeModule(db, "company-a", { nestId: "nest-a" });
    const injected = { ...input, companyId: "company-b", nestId: "nest-b" };
    await mod.create(injected, actor);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "nest-a", "original content");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "redacted content", companyId: "company-a", nestId: "nest-a" }, actor);
  });

  it("propagates redaction failure without calling the store", async () => {
    const error = new Error("redaction failed");
    ports.redact.mockRejectedValue(error);
    const mod = createKnowledgeModule(db, "company-a");
    await expect(mod.create(input, actor)).rejects.toBe(error);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "company-a", "original content");
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates store failure after redaction", async () => {
    const error = new Error("store failed");
    create.mockRejectedValue(error);
    const mod = createKnowledgeModule(db, "company-a");
    await expect(mod.create(input, actor)).rejects.toBe(error);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "company-a", "original content");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "redacted content", companyId: "company-a", nestId: "company-a" }, actor);
  });

  it("keeps two companies and their stores isolated", async () => {
    const createB = vi.fn().mockResolvedValue({ id: "item-b" });
    ports.makeStore.mockReturnValueOnce({ create }).mockReturnValueOnce({ create: createB });
    ports.redact.mockResolvedValueOnce({ text: "safe a" }).mockResolvedValueOnce({ text: "safe b" });
    const a = createKnowledgeModule(db, "company-a", { nestId: "nest-a" });
    const b = createKnowledgeModule(db, "company-b", { nestId: "nest-b" });
    expect(await a.create(input, actor)).toBe(stored);
    expect(await b.create({ ...input, content: "other content" }, actor)).toEqual({ id: "item-b" });
    expect(ports.redact).toHaveBeenCalledTimes(2);
    expect(ports.redact).toHaveBeenNthCalledWith(1, db, "nest-a", "original content");
    expect(ports.redact).toHaveBeenNthCalledWith(2, db, "nest-b", "other content");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "safe a", companyId: "company-a", nestId: "nest-a" }, actor);
    expect(createB).toHaveBeenCalledTimes(1);
    expect(createB).toHaveBeenCalledWith({ ...input, content: "safe b", companyId: "company-b", nestId: "nest-b" }, actor);
  });

  it("passes through an intentionally empty redacted text, not the original", async () => {
    ports.redact.mockResolvedValue({ text: "" });
    const mod = createKnowledgeModule(db, "company-a");
    expect(await mod.create(input, actor)).toBe(stored);
    expect(ports.redact).toHaveBeenCalledTimes(1);
    expect(ports.redact).toHaveBeenCalledWith(db, "company-a", "original content");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ ...input, content: "", companyId: "company-a", nestId: "company-a" }, actor);
  });
});
