// server/src/myrmidon/evals/judge.family-selection.myrmidon.test.ts
//
// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the review verdict on PR #611 was
//   (1) the built-in judge priority list may only name models the gateway
//       actually serves,
//   (2) a gateway error for the selected judge must fall through to the next
//       candidate — finally the configured model, flagged sameFamily —
//       instead of aborting the run,
//   (3) the family rules for 'yi', 'o1', 'o3', 'phi' must be token-anchored.
// These tests pin all three.

import { describe, expect, it } from "vitest";

import {
  createJudge,
  DEFAULT_EVALS_JUDGE_PRIORITY_MODELS,
  parseJudgePriorityModels,
  readEvalsSettings,
} from "./index.js";
import {
  DEFAULT_JUDGE_PRIORITY_MODELS,
  SERVED_FREE_GATEWAY_MODELS,
  getModelFamily,
  isSameJudgeFamily,
  judgeCandidateOrder,
} from "./model-family.js";

// Neutral data only (no real agents, keys or hosts).

const rubric = {
  criteria: [
    { name: "correctness", description: "the answer is correct", points: 3 },
    { name: "clarity", description: "the answer is clear", points: 2 },
  ],
};

function verdict(model: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"criteria": {"correctness": 3, "clarity": 2}}' } }],
    }),
    { status: 200 },
  );
}

describe("myrmidon(1.6.5 EVALS-JUDGE-FAMILY) verdict 1: default candidates are gateway-served", () => {
  it("every built-in default judge model is a gateway-served model", () => {
    // The served list is the verification contract: an id the gateway does
    // not serve must not be a default (the old list carried unverified ids
    // like `glm-4-flash-free`, `qwen-plus`, `qwen-max`).
    for (const model of DEFAULT_JUDGE_PRIORITY_MODELS) {
      expect(SERVED_FREE_GATEWAY_MODELS).toContain(model);
    }
    expect(DEFAULT_JUDGE_PRIORITY_MODELS.length).toBeGreaterThan(0);
  });

  it("the default priority list resolves to a served model", () => {
    const resolved = parseJudgePriorityModels(undefined);
    expect(resolved).toEqual(DEFAULT_JUDGE_PRIORITY_MODELS);
    expect(SERVED_FREE_GATEWAY_MODELS).toContain(resolved[0]);
    // readEvalsSettings with no env yields the same served head.
    const settings = readEvalsSettings({});
    expect(settings.judgeModels[0]).toBe(SERVED_FREE_GATEWAY_MODELS[0]);
    expect(DEFAULT_EVALS_JUDGE_PRIORITY_MODELS).toEqual(DEFAULT_JUDGE_PRIORITY_MODELS);
  });

  it("an operator-listed cross-family model is kept as-is", () => {
    // Validation of operator input is the gateway's job; the contour only
    // replaces empty/unset with the served defaults.
    const models = parseJudgePriorityModels("deepseek-v3, qwen-plus-free");
    expect(models).toEqual(["deepseek-v3", "qwen-plus-free"]);
  });
});

describe("myrmidon(1.6.5 EVALS-JUDGE-FAMILY) verdict 2: gateway errors fall through", () => {
  it("a gateway error for the first candidate falls back to the next candidate", async () => {
    const seen: string[] = [];
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      seen.push(model);
      if (model === "qwen-plus-free") return new Response("upstream exploded", { status: 502 });
      return verdict(model);
    }) as typeof fetch;

    const judge = createJudge({
      fetch: fetchMock,
      apiKey: "test-key",
      baseUrl: "http://gateway.test",
      model: "qwen-plus-free",
      judgeModels: ["qwen-plus-free", "qwen-max-free"],
      timeoutMs: 1000,
    });
    const result = await judge.judgeTask({
      taskSlug: "t",
      prompt: "p",
      answer: "a",
      rubric,
      kind: "general",
      agentModel: "gpt-4o",
    });
    // qwen-plus-free 502s, qwen-max-free answers — the run is scored, not aborted.
    expect(seen).toEqual(["qwen-plus-free", "qwen-max-free"]);
    expect(result.parseError).toBe(false);
    expect(result.awarded).toEqual({ correctness: 3, clarity: 2 });
  });

  it("a transport failure on every candidate falls back to the configured model flagged sameFamily", async () => {
    const seen: string[] = [];
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      seen.push(model);
      if (model !== "configured-model") throw new Error("connection refused");
      return verdict(model);
    }) as typeof fetch;

    const judge = createJudge({
      fetch: fetchMock,
      apiKey: "test-key",
      baseUrl: "http://gateway.test",
      model: "configured-model",
      judgeModels: ["candidate-a", "candidate-b"],
      timeoutMs: 1000,
    });
    const result = await judge.judgeTask({
      taskSlug: "t",
      prompt: "p",
      answer: "a",
      rubric,
      kind: "general",
      agentModel: "configured-model",
    });
    // candidates first (cross-family: unknown != configured), then deps.model.
    expect(seen).toEqual(["candidate-a", "candidate-b", "configured-model"]);
    expect(result.sameFamily).toBe(true);
    expect(result.parseError).toBe(false);
  });

  it("throws only when the whole chain fails", async () => {
    const fetchMock = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const judge = createJudge({
      fetch: fetchMock,
      apiKey: "test-key",
      baseUrl: "http://gateway.test",
      model: "m",
      judgeModels: ["m"],
      timeoutMs: 1000,
    });
    await expect(
      judge.judgeTask({ taskSlug: "t", prompt: "p", answer: "a", rubric, kind: "general", agentModel: "other-x" }),
    ).rejects.toMatchObject({ code: "judge_unreachable" });
  });

  it("without a candidate list the judge runs on the configured model once", async () => {
    const seen: string[] = [];
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const judge = createJudge({
      fetch: fetchMock,
      apiKey: "test-key",
      baseUrl: "http://gateway.test",
      model: "solo-model",
      timeoutMs: 1000,
    });
    await expect(
      judge.judgeTask({ taskSlug: "t", prompt: "p", answer: "a", rubric, kind: "general" }),
    ).rejects.toMatchObject({ code: "judge_http_error" });
    expect(seen).toEqual(["solo-model"]);
  });
});

describe("myrmidon(1.6.5 EVALS-JUDGE-FAMILY) verdict 3: token-anchored family rules", () => {
  it("bare substrings no longer misclassify collision-prone ids", () => {
    // `phi` must not match `dolphin`; `yi` must not match any id merely
    // containing the two letters; `o1`/`o3` must be whole tokens.
    expect(getModelFamily("dolphin-mistral-7b")).not.toBe("phi");
    expect(getModelFamily("deepyida-v2")).not.toBe("yi");
    expect(getModelFamily("proxy-model-o11y")).not.toBe("gpt");
    expect(getModelFamily("co3-incubator")).not.toBe("gpt");
    // Real family members still classify.
    expect(getModelFamily("microsoft/phi-4")).toBe("phi");
    expect(getModelFamily("01-ai/yi-large")).toBe("yi");
    expect(getModelFamily("openai/o3-mini")).toBe("gpt");
    expect(getModelFamily("o1")).toBe("gpt");
  });

  it("candidate order puts a cross-family model first and dedupes the fallback", () => {
    const order = judgeCandidateOrder(
      "qwen-plus",
      ["qwen-plus-free", "deepseek-v3", "qwen-turbo-free"],
      "qwen-plus-free",
    );
    expect(order[0]).toBe("deepseek-v3"); // cross-family candidate first
    // the same-family candidates follow in their original relative order;
    // the fallback is already among them, so it appears exactly once.
    expect(order).toEqual(["deepseek-v3", "qwen-plus-free", "qwen-turbo-free"]);
    expect(order.filter((m) => m === "qwen-plus-free")).toEqual(["qwen-plus-free"]);
    // a fallback absent from the priority list is appended last...
    expect(judgeCandidateOrder("qwen-plus", ["deepseek-v3"], "qwen-plus-free")).toEqual([
      "deepseek-v3",
      "qwen-plus-free",
    ]);
    // ...and with no cross-family candidate the head (same-family) still judges.
    expect(judgeCandidateOrder("qwen-plus", ["qwen-plus-free"], "qwen-plus-free")).toEqual([
      "qwen-plus-free",
    ]);
    expect(isSameJudgeFamily("deepseek-v3", "qwen-plus")).toBe(false);
    expect(isSameJudgeFamily("qwen-plus-free", "qwen-plus")).toBe(true);
  });

  it("without an agent model the order is the configured model only", () => {
    // An unset subject must not silently re-route the judge through the
    // priority list — the pre-1.6.5 behavior stays for that case.
    expect(judgeCandidateOrder(undefined, ["a-model", "b-model"], "m")).toEqual(["m"]);
  });
});
