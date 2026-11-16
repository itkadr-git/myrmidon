import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createKnowledgeModule } from "./service.js";

const ports = vi.hoisted(() => ({
  suggest: vi.fn(),
  decideSuggestion: vi.fn(),
  listSuggestions: vi.fn(),
  exportTree: vi.fn(),
  importTree: vi.fn(),
  create: vi.fn(),
  index: vi.fn(),
  redact: vi.fn(),
}));

vi.mock("./store.js", () => ({ createKnowledgeService: ports.create }));
vi.mock("../redact/service.js", () => ({ redactNestText: ports.redact }));
vi.mock("@myrmidon/db", () => ({ createPgKnowledgeSearchIndex: ports.index }));

const db = {} as Db;
const company = "company-a";
const nest = "nest-a";
const actor = { actorType: "user", actorId: "user-a" } as const;

beforeEach(() => {
  vi.resetAllMocks();
  ports.create.mockReturnValue(ports);
  ports.index.mockReturnValue({});
});

describe("knowledge module suggestion and tree scope", () => {
  it("binds the default nest to the company", async () => {
    const result = [{ id: "suggestion-a" }];
    ports.listSuggestions.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company);
    expect(module.nestId).toBe(company);
    expect(await module.listSuggestions()).toBe(result);
    expect(ports.listSuggestions).toHaveBeenCalledExactlyOnceWith(company, undefined);
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.index).toHaveBeenCalledExactlyOnceWith(db);
  });

  it("overrides a runtime foreign company on suggest with a custom nest", async () => {
    const result = { id: "suggestion-a" };
    const input = { companyId: "company-b", body: "A suggestion", targetSlug: "guide", rationale: "reason" };
    ports.suggest.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company, { nestId: nest });
    expect(await module.suggest(actor, input)).toBe(result);
    expect(ports.suggest).toHaveBeenCalledExactlyOnceWith(nest, actor, {
      companyId: company, body: "A suggestion", targetSlug: "guide", rationale: "reason",
    });
    expect(input.companyId).toBe("company-b");
  });

  it("overrides a runtime foreign company on decideSuggestion", async () => {
    const result = { id: "suggestion-a", status: "accepted" };
    const input = { companyId: "company-b", suggestionId: "suggestion-a", decision: "accepted" } as const;
    ports.decideSuggestion.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company, { nestId: nest });
    expect(await module.decideSuggestion(actor, input)).toBe(result);
    expect(ports.decideSuggestion).toHaveBeenCalledExactlyOnceWith(nest, actor, {
      companyId: company, suggestionId: "suggestion-a", decision: "accepted",
    });
    expect(input.companyId).toBe("company-b");
  });

  it.each(["pending", "accepted", "declined", "all"] as const)("passes status %s without changing the returned list", async (status) => {
    const result = [{ id: "suggestion-a", status }];
    ports.listSuggestions.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company, { nestId: nest });
    expect(await module.listSuggestions(status)).toBe(result);
    expect(ports.listSuggestions).toHaveBeenCalledExactlyOnceWith(nest, status);
  });

  it("exports the custom nest and preserves buffer identity", async () => {
    const result = Buffer.from("tree-a");
    ports.exportTree.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company, { nestId: nest });
    expect(await module.exportTree()).toBe(result);
    expect(ports.exportTree).toHaveBeenCalledExactlyOnceWith(nest);
  });

  it("imports with bound company and nest, the same buffer, actor and options", async () => {
    const buffer = Buffer.from("tree-a");
    const options = { publishOnImport: true, approverKind: "owner" };
    const result = { imported: 1 };
    ports.importTree.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company, { nestId: nest });
    expect(await module.importTree(buffer, actor, options)).toBe(result);
    expect(ports.importTree).toHaveBeenCalledExactlyOnceWith(company, nest, buffer, actor, options);
    expect(ports.importTree.mock.calls[0][2]).toBe(buffer);
    expect(ports.importTree.mock.calls[0][3]).toBe(actor);
    expect(ports.importTree.mock.calls[0][4]).toBe(options);
  });

  it("passes undefined options and the default nest on import", async () => {
    const buffer = Buffer.from("tree-b");
    const result = { imported: 2 };
    ports.importTree.mockResolvedValue(result);
    const module = createKnowledgeModule(db, company);
    expect(await module.importTree(buffer, actor)).toBe(result);
    expect(ports.importTree).toHaveBeenCalledExactlyOnceWith(company, company, buffer, actor, undefined);
  });

  it.each(["suggest", "decideSuggestion", "listSuggestions", "exportTree", "importTree"] as const)("preserves rejection from %s", async (method) => {
    const failure = new Error(`failure from ${method}`);
    ports[method].mockRejectedValue(failure);
    const module = createKnowledgeModule(db, company, { nestId: nest });
    const calls = {
      suggest: () => module.suggest(actor, { body: "A suggestion" }),
      decideSuggestion: () => module.decideSuggestion(actor, { suggestionId: "suggestion-a", decision: "declined" }),
      listSuggestions: () => module.listSuggestions("all"),
      exportTree: () => module.exportTree(),
      importTree: () => module.importTree(Buffer.from("tree"), actor),
    };
    await expect(calls[method]()).rejects.toBe(failure);
    expect(ports[method]).toHaveBeenCalledTimes(1);
  });
});
