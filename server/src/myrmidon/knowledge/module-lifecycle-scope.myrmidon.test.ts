import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createKnowledgeModule } from "./service.js";

const ports = vi.hoisted(() => ({
  createKnowledgeService: vi.fn(),
  createPgKnowledgeSearchIndex: vi.fn(),
  redactNestText: vi.fn(),
  store: {
    submit: vi.fn(), publish: vi.fn(), approve: vi.fn(), rollback: vi.fn(),
    archive: vi.fn(), supersede: vi.fn(), recordGateJournal: vi.fn(),
  },
}));
vi.mock("./store.js", () => ({ createKnowledgeService: ports.createKnowledgeService }));
vi.mock("../redact/service.js", () => ({ redactNestText: ports.redactNestText }));
vi.mock("@myrmidon/db", () => ({ createPgKnowledgeSearchIndex: ports.createPgKnowledgeSearchIndex }));

const db = {} as Db;
const companyId = "company-a";
const customNest = "nest-b";
const slug = "guide/example";
const actor = { actorType: "user" as const, actorId: "user-a" };
const approveInput = { revisionId: "revision-a", approvalId: "approval-a", publish: true };
const rollbackInput = { targetRevisionId: "revision-b", changeSummary: "restore" };
const supersedeInput = { bySlug: "guide/replacement" };
const journalInput = { subjectKind: "item", subjectRef: "subject-a", evalRunId: "eval-a", delta: 0.25, verdict: "keep" as const };

type Module = ReturnType<typeof createKnowledgeModule>;
const cases = [
  { name: "submit with revision", port: "submit", invoke: (m: Module) => m.submit(slug, actor, "revision-a"), args: [slug, actor, "revision-a"] },
  { name: "submit without revision", port: "submit", invoke: (m: Module) => m.submit(slug, actor), args: [slug, actor, undefined] },
  { name: "publish with revision", port: "publish", invoke: (m: Module) => m.publish(slug, actor, "revision-b"), args: [slug, actor, "revision-b"] },
  { name: "publish without revision", port: "publish", invoke: (m: Module) => m.publish(slug, actor), args: [slug, actor, undefined] },
  { name: "approve with input", port: "approve", invoke: (m: Module) => m.approve(slug, actor, approveInput), args: [slug, actor, approveInput] },
  { name: "approve without input", port: "approve", invoke: (m: Module) => m.approve(slug, actor), args: [slug, actor, undefined] },
  { name: "rollback", port: "rollback", invoke: (m: Module) => m.rollback(slug, actor, rollbackInput), args: [slug, actor, rollbackInput] },
  { name: "archive", port: "archive", invoke: (m: Module) => m.archive(slug, actor), args: [slug, actor] },
  { name: "supersede", port: "supersede", invoke: (m: Module) => m.supersede(slug, actor, supersedeInput), args: [slug, actor, supersedeInput] },
  { name: "record gate journal", port: "recordGateJournal", invoke: (m: Module) => m.recordGateJournal(slug, actor, journalInput), args: [slug, actor, journalInput] },
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  ports.createKnowledgeService.mockReturnValue(ports.store);
  ports.createPgKnowledgeSearchIndex.mockReturnValue({});
});

describe("knowledge module lifecycle composition", () => {
  for (const scope of [{ name: "default", nestId: companyId }, { name: "custom", nestId: customNest }]) {
    for (const testCase of cases) {
      it(`${scope.name} nest forwards ${testCase.name} and its result`, async () => {
        const mod = createKnowledgeModule(db, companyId, scope.name === "custom" ? { nestId: customNest } : {});
        const result = { id: "result-a" };
        const response = Promise.resolve(result);
        ports.store[testCase.port].mockReturnValueOnce(response);
        expect(mod.companyId).toBe(companyId);
        expect(mod.nestId).toBe(scope.nestId);
        expect(testCase.invoke(mod)).toBe(response);
        await expect(response).resolves.toBe(result);
        expect(ports.store[testCase.port]).toHaveBeenCalledExactlyOnceWith(scope.nestId, ...testCase.args);
        for (const [name, mock] of Object.entries(ports.store)) {
          if (name !== testCase.port) expect(mock).not.toHaveBeenCalled();
        }
        expect(ports.redactNestText).not.toHaveBeenCalled();
      });

      it(`${scope.name} nest propagates ${testCase.name} rejection`, async () => {
        const mod = createKnowledgeModule(db, companyId, scope.name === "custom" ? { nestId: customNest } : {});
        const error = new Error("port refused");
        ports.store[testCase.port].mockRejectedValueOnce(error);
        await expect(testCase.invoke(mod)).rejects.toBe(error);
        expect(ports.store[testCase.port]).toHaveBeenCalledExactlyOnceWith(scope.nestId, ...testCase.args);
        for (const [name, mock] of Object.entries(ports.store)) {
          if (name !== testCase.port) expect(mock).not.toHaveBeenCalled();
        }
      });
    }
  }
});
