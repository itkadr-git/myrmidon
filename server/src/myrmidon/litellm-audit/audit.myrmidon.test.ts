// server/src/myrmidon/litellm-audit/audit.myrmidon.test.ts
//
// myrmidon(OPE-9857): unit tests for LiteLLM audit log, secret redaction,
// legacy audit record migration, and safe one-action rollback with re-authorization.

import { describe, expect, it, vi } from "vitest";
import { redactCredentials } from "./redaction.js";
import { migrateAuditRecord } from "./migration.js";
import { createLiteLlmAuditService } from "./service.js";
import type { LiteLlmRollbackHandlers } from "./service.js";

describe("LiteLLM settings audit & rollback (OPE-9857)", () => {
  describe("Secret & credential redaction", () => {
    it("redacts secret fields and credential patterns recursively", () => {
      const input = {
        name: "OpenAI Provider",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-proj-1234567890abcdef1234567890",
        nested: {
          token: "secret-token-value",
          secret: "super-secret",
          free: false,
          models: [
            {
              modelName: "gpt-4o",
              enabled: true,
              key: "sk-key-here",
            },
          ],
        },
      };

      const redacted = redactCredentials(input) as Record<string, unknown>;
      expect(redacted.name).toBe("OpenAI Provider");
      expect(redacted.baseUrl).toBe("https://api.openai.com/v1");
      expect(redacted.apiKey).toBe("[REDACTED]");

      const nested = redacted.nested as Record<string, unknown>;
      expect(nested.token).toBe("[REDACTED]");
      expect(nested.secret).toBe("[REDACTED]");
      expect(nested.free).toBe(false);

      const models = nested.models as Array<Record<string, unknown>>;
      expect(models[0].modelName).toBe("gpt-4o");
      expect(models[0].enabled).toBe(true);
      expect(models[0].key).toBe("[REDACTED]");
    });

    it("redacts strings starting with known secret prefixes even in generic fields", () => {
      const input = {
        config: "sk-test1234567890abcdef",
        header: "Bearer token12345678",
      };
      const redacted = redactCredentials(input) as Record<string, unknown>;
      expect(redacted.config).toBe("[REDACTED]");
      expect(redacted.header).toBe("[REDACTED]");
    });
  });

  describe("Audit/Migration parser", () => {
    it("migrates legacy activity_log rows into structured LiteLlmAuditEntry", () => {
      const legacyRow = {
        id: "act-legacy-1",
        companyId: "comp-1",
        actorType: "user",
        actorId: "admin-1",
        action: "model_provider_added",
        entityType: "model_provider",
        entityId: "prov-1",
        createdAt: new Date("2026-10-01T12:00:00Z"),
        details: {
          name: "Claude Provider",
          type: "anthropic",
          apiKey: "sk-ant-1234567890",
        },
      };

      const entry = migrateAuditRecord(legacyRow);
      expect(entry.id).toBe("act-legacy-1");
      expect(entry.companyId).toBe("comp-1");
      expect(entry.category).toBe("models");
      expect(entry.action).toBe("model_provider_added");
      expect(entry.actor).toEqual({ type: "user", id: "admin-1" });
      expect(entry.timestamp).toBe("2026-10-01T12:00:00.000Z");
      expect(entry.before).toBeNull();
      expect(entry.after).toBeDefined();
      expect((entry.after as Record<string, unknown>).name).toBe("Claude Provider");
      expect((entry.after as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    });

    it("parses structured audit entries preserving category and diffs", () => {
      const row = {
        id: "audit-2",
        companyId: "comp-1",
        actorType: "board",
        actorId: "user-2",
        action: "litellm_fallbacks_updated",
        entityType: "litellm_audit",
        entityId: "fallbacks",
        createdAt: "2026-10-02T15:00:00Z",
        details: {
          category: "fallbacks",
          before: { fallbacks: { "gpt-4o": ["claude-3-5-sonnet"] } },
          after: { fallbacks: { "gpt-4o": ["gemini-1.5-pro"] } },
          summary: "Updated fallback chain",
          canRollback: true,
        },
      };

      const entry = migrateAuditRecord(row);
      expect(entry.category).toBe("fallbacks");
      expect(entry.canRollback).toBe(true);
      expect(entry.before).toEqual({ fallbacks: { "gpt-4o": ["claude-3-5-sonnet"] } });
      expect(entry.after).toEqual({ fallbacks: { "gpt-4o": ["gemini-1.5-pro"] } });
    });
  });

  describe("Audit Service & Safe Rollback", () => {
    it("records audit entry with sanitized before and after states", async () => {
      const inserted: unknown[] = [];
      const fakeDb = {
        insert: () => ({
          values: (val: unknown) => {
            inserted.push(val);
            return {
              returning: async () => [{ ...(val as object), id: "new-audit-id" }],
            };
          },
        }),
      } as unknown as Parameters<typeof createLiteLlmAuditService>[0];

      const service = createLiteLlmAuditService(fakeDb);

      const entry = await service.record({
        companyId: "comp-1",
        category: "models",
        action: "model_provider_patched",
        entityId: "prov-1",
        actor: { type: "board", id: "user-1" },
        before: { name: "Old Name", key: "sk-secret-old" },
        after: { name: "New Name", key: "sk-secret-new" },
        summary: "Updated provider name",
        canRollback: true,
      });

      expect(entry.id).toBe("new-audit-id");
      expect(entry.category).toBe("models");
      expect(entry.before).toEqual({ name: "Old Name", key: "[REDACTED]" });
      expect(entry.after).toEqual({ name: "New Name", key: "[REDACTED]" });
      expect(inserted.length).toBe(1);
    });

    it("requires board authorization for rollback (rejects agent actor)", async () => {
      const service = createLiteLlmAuditService({} as unknown as Parameters<typeof createLiteLlmAuditService>[0]);

      await expect(
        service.rollback({
          companyId: "comp-1",
          auditId: "audit-1",
          actor: { type: "agent", id: "bot-1" },
        }),
      ).rejects.toThrow("Rollback requires board authorization");
    });

    it("restores previous non-secret state in one action and logs rollback", async () => {
      const targetEntry = {
        id: "audit-models-1",
        companyId: "comp-1",
        actorType: "board",
        actorId: "user-1",
        action: "model_provider_models_updated",
        entityType: "litellm_audit",
        entityId: "prov-1",
        createdAt: new Date("2026-10-02T10:00:00Z"),
        details: {
          category: "models",
          before: {
            models: [
              { modelName: "gpt-4o", enabled: false },
              { modelName: "qwen-plus", enabled: true },
            ],
          },
          after: {
            models: [
              { modelName: "gpt-4o", enabled: true },
              { modelName: "qwen-plus", enabled: false },
            ],
          },
          summary: "Updated model flags",
          canRollback: true,
        },
      };

      const inserted: unknown[] = [];
      const fakeDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [targetEntry],
            }),
          }),
        }),
        insert: () => ({
          values: (val: unknown) => {
            inserted.push(val);
            return {
              returning: async () => [{ ...(val as object), id: "rollback-audit-id" }],
            };
          },
        }),
      } as unknown as Parameters<typeof createLiteLlmAuditService>[0];

      const service = createLiteLlmAuditService(fakeDb);

      const restoreModelsMock = vi.fn().mockResolvedValue(undefined);
      const handlers: LiteLlmRollbackHandlers = {
        restoreModels: restoreModelsMock,
      };

      const result = await service.rollback(
        {
          companyId: "comp-1",
          auditId: "audit-models-1",
          actor: { type: "board", id: "user-1" },
        },
        handlers,
      );

      expect(result.success).toBe(true);
      expect(result.auditId).toBe("audit-models-1");
      expect(restoreModelsMock).toHaveBeenCalledWith("comp-1", "prov-1", [
        { modelName: "gpt-4o", enabled: false },
        { modelName: "qwen-plus", enabled: true },
      ]);
      expect(result.restoredState).toEqual({
        models: [
          { modelName: "gpt-4o", enabled: false },
          { modelName: "qwen-plus", enabled: true },
        ],
      });
      // Verifies a new audit entry documenting the rollback was recorded
      expect(inserted.length).toBe(1);
      const rollbackRecord = inserted[0] as Record<string, unknown>;
      expect(rollbackRecord.action).toBe("litellm_audit_rollback");
    });
  });
});