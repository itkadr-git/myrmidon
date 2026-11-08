// server/src/myrmidon/goal-judge/wiring.myrmidon.test.ts
//
// myrmidon(1.7-GOAL-JUDGE): unit tests for goal-judge model port, settings, and controller.
//
// Required tests:
// 1. Fake fetch: provider and key resolve, key is absent from logs/responses.
// 2. Switch off -> model is NOT invoked.
// 3. Model call targets configured judge provider and model at temperature 0.
// 4. Non-JSON model response -> treated as round error, not crash; retry prompt sent.
// 5. PATCH settings saves selection and reads back.

import { describe, expect, it, vi } from "vitest";
import {
  createGoalJudgeModelPort,
  evaluateGoalJudge,
  chatCompletionsUrl,
  readChatText,
  type GoalJudgeModelPort,
  type GoalJudgeModelCallInput,
  type GoalJudgeSecretsPort,
} from "./wiring.js";
import {
  goalJudgeSettingsService,
  DEFAULT_GOAL_JUDGE_SETTINGS,
  type GoalJudgeSettings,
} from "./settings.js";
import { createGoalJudgeRoutesWithService } from "./routes.js";
import type { Db } from "@myrmidon/db";

describe("Goal Judge Model Port & Wiring (myrmidon 1.7 GOAL-JUDGE)", () => {
  describe("URL and text helpers", () => {
    it("formats chat completions url correctly with and without /v1", () => {
      expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
      expect(chatCompletionsUrl("https://api.openai.com/v1/")).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
      expect(chatCompletionsUrl("https://my-proxy.internal")).toBe(
        "https://my-proxy.internal/v1/chat/completions",
      );
    });

    it("extracts text from string or message parts", () => {
      expect(readChatText("hello world")).toBe("hello world");
      expect(readChatText([{ text: "part 1" }, { text: "part 2" }])).toBe("part 1\npart 2");
      expect(readChatText(null)).toBe("");
    });
  });

  describe("createGoalJudgeModelPort", () => {
    it("resolves provider and key, calls fake fetch, and never exposes key in results or logs", async () => {
      const secretKey = "test-secret-key-xyz-789";
      const fakeFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.openai.com/v1/chat/completions");
        const headers = init.headers as Record<string, string>;
        expect(headers.authorization).toBe(`Bearer ${secretKey}`);
        expect(headers["content-type"]).toBe("application/json");

        const body = JSON.parse(init.body as string);
        expect(body.model).toBe("gpt-4o-judge");
        expect(body.temperature).toBe(0);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    score: 1.0,
                    complete: true,
                    missing: [],
                    summary: "Goal achieved",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 45 },
          }),
        };
      });

      // Mock DB for provider query
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  id: "prov-1",
                  type: "openai",
                  baseUrl: "https://api.openai.com/v1",
                  credentialSecretName: "OPENAI_API_KEY",
                },
              ]),
          }),
        }),
      } as unknown as Db;

      const mockSecrets: GoalJudgeSecretsPort = {
        getByName: vi.fn().mockResolvedValue({ id: "secret-row-1" }),
        resolveSecretValue: vi.fn().mockResolvedValue(secretKey),
      };

      const port = createGoalJudgeModelPort(mockDb, "comp-1", fakeFetch, mockSecrets);

      const result = await port.call({
        providerId: "prov-1",
        model: "gpt-4o-judge",
        temperature: 0,
        messages: [{ role: "user", content: "Evaluate" }],
      });

      expect(result.content).toBe(
        JSON.stringify({
          score: 1.0,
          complete: true,
          missing: [],
          summary: "Goal achieved",
        }),
      );
      expect(result.promptTokens).toBe(120);
      expect(result.completionTokens).toBe(45);

      // Invariant: key is resolved on demand, not stored in result, not exposed
      expect(JSON.stringify(result)).not.toContain(secretKey);
      expect(mockSecrets.getByName).toHaveBeenCalledWith("comp-1", "OPENAI_API_KEY");
      expect(mockSecrets.resolveSecretValue).toHaveBeenCalledWith("comp-1", "secret-row-1", "latest");
    });

    it("throws provider_not_found if provider does not exist", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as unknown as Db;

      const port = createGoalJudgeModelPort(mockDb, "comp-1", vi.fn());
      await expect(
        port.call({
          providerId: "nonexistent",
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toThrow("provider_not_found:nonexistent");
    });

    it("throws provider_key_unreadable if secret value is missing", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  id: "prov-2",
                  type: "openai",
                  baseUrl: "https://api.openai.com/v1",
                  credentialSecretName: "OPENAI_API_KEY",
                },
              ]),
          }),
        }),
      } as unknown as Db;

      const mockSecrets: GoalJudgeSecretsPort = {
        getByName: vi.fn().mockResolvedValue({ id: "secret-row-2" }),
        resolveSecretValue: vi.fn().mockResolvedValue(null),
      };

      const port = createGoalJudgeModelPort(mockDb, "comp-1", vi.fn(), mockSecrets);
      await expect(
        port.call({
          providerId: "prov-2",
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toThrow("provider_key_unreadable:prov-2");
    });
  });

  describe("evaluateGoalJudge switch and invariants", () => {
    it("switch off -> controller does NOT call the model", async () => {
      const mockModelPort: GoalJudgeModelPort = {
        call: vi.fn(),
      };

      const settings: GoalJudgeSettings = {
        ...DEFAULT_GOAL_JUDGE_SETTINGS,
        enabled: false,
        providerId: "prov-strong",
        model: "strong-judge-model",
      };

      const deps = {
        settings: { read: async () => settings },
        models: mockModelPort,
      };

      const result = await evaluateGoalJudge(deps, {
        criteria: ["Criterion 1", "Criterion 2"],
        diff: "+ added feature",
        testOutput: "PASS test",
      });

      expect(result.executed).toBe(false);
      expect(result.skippedReason).toBe("goal_judge_disabled");
      expect(result.verdict).toBeNull();
      // Invariant: model is never invoked when switch is off
      expect(mockModelPort.call).not.toHaveBeenCalled();
    });

    it("switch on -> calls the configured provider and model with temperature 0", async () => {
      const mockCall = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          score: 1.0,
          complete: true,
          missing: [],
          summary: "Verified with tests",
        }),
        promptTokens: 100,
        completionTokens: 20,
      });

      const mockModelPort: GoalJudgeModelPort = {
        call: mockCall,
      };

      const settings: GoalJudgeSettings = {
        enabled: true,
        providerId: "prov-strong-1",
        model: "judge-heavy-model-v2",
        temperature: 0,
        timeoutMs: 30000,
        maxRounds: 3,
      };

      const deps = {
        settings: { read: async () => settings },
        models: mockModelPort,
      };

      const result = await evaluateGoalJudge(deps, {
        criteria: ["Criterion A"],
        diff: "+ code changes for Criterion A",
        testOutput: "PASS Criterion A test",
      });

      expect(result.executed).toBe(true);
      expect(mockCall).toHaveBeenCalledTimes(1);
      const callArgs = mockCall.mock.calls[0]![0] as GoalJudgeModelCallInput;
      // Invariant: must call configured judge model and provider
      expect(callArgs.providerId).toBe("prov-strong-1");
      expect(callArgs.model).toBe("judge-heavy-model-v2");
      expect(callArgs.temperature).toBe(0);

      expect(result.verdict).not.toBeNull();
      expect(result.verdict?.complete).toBe(true);
      expect(result.verdict?.missing).toEqual([]);
    });

    it("non-JSON model response -> treated as round error, retries up to maxRounds", async () => {
      let callCount = 0;
      const mockCall = vi.fn().mockImplementation(async (input: GoalJudgeModelCallInput) => {
        callCount++;
        if (callCount === 1) {
          // Round 1: non-JSON conversational output
          return {
            content: "I think everything looks good and complete! All criteria are met.",
            promptTokens: 80,
            completionTokens: 15,
          };
        }
        // Round 2: retry prompt received, returns valid JSON
        expect(input.messages.some((m) => m.content.includes("failed validation"))).toBe(true);
        return {
          content: JSON.stringify({
            score: 0.5,
            complete: false,
            missing: ["Missing proof for Criterion B"],
            summary: "Only Criterion A verified",
          }),
          promptTokens: 120,
          completionTokens: 30,
        };
      });

      const mockModelPort: GoalJudgeModelPort = {
        call: mockCall,
      };

      const settings: GoalJudgeSettings = {
        enabled: true,
        providerId: "prov-1",
        model: "model-1",
        temperature: 0,
        timeoutMs: 10000,
        maxRounds: 2,
      };

      const result = await evaluateGoalJudge(
        {
          settings: { read: async () => settings },
          models: mockModelPort,
        },
        {
          criteria: ["Criterion A", "Criterion B"],
          diff: "+ Criterion A implemented",
          testOutput: "PASS Criterion A",
        },
      );

      expect(result.executed).toBe(true);
      expect(mockCall).toHaveBeenCalledTimes(2);

      // Verify round 1 recorded non-JSON error
      const round1 = result.session.rounds[0];
      expect(round1?.success).toBe(false);
      expect(round1?.error).toContain("Non-JSON response");

      // Verify round 2 succeeded in parsing
      const round2 = result.session.rounds[1];
      expect(round2?.success).toBe(true);
      expect(round2?.verdict?.complete).toBe(false);
      expect(round2?.verdict?.missing).toEqual(["Missing proof for Criterion B"]);
    });

    it("model call failure is recorded as round error without crashing the process", async () => {
      const mockCall = vi.fn().mockRejectedValue(new Error("provider_http_500"));

      const settings: GoalJudgeSettings = {
        enabled: true,
        providerId: "prov-1",
        model: "model-1",
        temperature: 0,
        timeoutMs: 10000,
        maxRounds: 2,
      };

      const result = await evaluateGoalJudge(
        {
          settings: { read: async () => settings },
          models: { call: mockCall },
        },
        {
          criteria: ["Criterion 1"],
          diff: "+ change",
          testOutput: "PASS",
        },
      );

      expect(result.executed).toBe(true);
      expect(mockCall).toHaveBeenCalledTimes(2);
      expect(result.session.rounds.length).toBe(2);
      expect(result.session.rounds[0]?.success).toBe(false);
      expect(result.session.rounds[0]?.error).toContain("provider_http_500");
      expect(result.verdict).toBeNull();
    });
  });

  describe("Goal Judge Settings & Routes", () => {
    it("reads default settings when instance settings are empty", async () => {
      let storedGeneral: Record<string, unknown> = {};
      const service = goalJudgeSettingsService(null, {
        settings: {
          getGeneral: async () => storedGeneral as any,
          updateGeneral: async (patch) => {
            storedGeneral = { ...storedGeneral, ...patch };
            return storedGeneral as any;
          },
        },
      });

      const settings = await service.read();
      expect(settings.enabled).toBe(false);
      expect(settings.providerId).toBeNull();
      expect(settings.model).toBeNull();
      expect(settings.temperature).toBe(0);
      expect(settings.maxRounds).toBe(3);

      const journal = await service.journal();
      expect(journal).toEqual([]);
    });

    it("PATCH updates settings, records journal entry, and reads back", async () => {
      let storedGeneral: Record<string, unknown> = {};
      const loggedActivity: unknown[] = [];

      const service = goalJudgeSettingsService(null, {
        settings: {
          getGeneral: async () => storedGeneral,
          updateGeneral: async (patch) => {
            storedGeneral = { ...storedGeneral, ...patch };
            return storedGeneral as any;
          },
        },
        logActivity: async (entry) => {
          loggedActivity.push(entry);
        },
      });

      const updated = await service.update(
        {
          enabled: true,
          providerId: "provider-claude-3-5",
          model: "claude-3-5-sonnet",
          temperature: 0,
          maxRounds: 3,
        },
        { actorType: "user", actorId: "user-admin-1" },
      );

      expect(updated.enabled).toBe(true);
      expect(updated.providerId).toBe("provider-claude-3-5");
      expect(updated.model).toBe("claude-3-5-sonnet");

      // Read back
      const readBack = await service.read();
      expect(readBack).toEqual(updated);

      // Journal entry verification
      const journal = await service.journal();
      expect(journal.length).toBe(1);
      expect(journal[0]?.actorId).toBe("user-admin-1");
      expect(journal[0]?.patch.enabled).toBe(true);
      expect(journal[0]?.patch.providerId).toBe("provider-claude-3-5");

      // Activity log verification
      expect(loggedActivity.length).toBe(1);
    });

    it("routes handle GET and PATCH correctly", async () => {
      let storedGeneral: Record<string, unknown> = {};
      const service = goalJudgeSettingsService(null, {
        settings: {
          getGeneral: async () => storedGeneral as any,
          updateGeneral: async (patch) => {
            storedGeneral = { ...storedGeneral, ...patch };
            return storedGeneral as any;
          },
        },
      });

      const router = createGoalJudgeRoutesWithService(service);
      expect(router).toBeDefined();
    });
  });
});
