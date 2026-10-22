// server/src/myrmidon/evals/judge.family.test.ts
//
// Test the same-family detection feature for eval judges.

import { describe, it, expect } from "vitest";
import { createJudge, parseJudgeResponse } from "./judge.js";
import { DEFAULT_EVALS_MODEL } from "./judge.js";

describe("judge same-family detection", () => {
  it("should detect when judge and agent are from the same family", async () => {
    // Mock fetch implementation that returns a valid judge response
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { 
            content: '{"criteria": {"accuracy": 5, "completeness": 4}}'
          }
        }]
      })
    });

    const judge = createJudge({
      fetch: mockFetch as any,
      apiKey: "***",
      baseUrl: "http://test.local",
      model: "qwen-plus-free", // Qwen family
      timeoutMs: 10000,
    });

    // Test when agent uses the same family model
    const result = await judge.judgeTask({
      taskSlug: "test-task",
      prompt: "Test prompt",
      answer: "Test answer",
      rubric: { criteria: [{ name: "accuracy", description: "Accuracy", points: 5 }, { name: "completeness", description: "Completeness", points: 5 }] },
      kind: "general",
      agentModel: "qwen-plus", // Same family
    });

    expect(result.sameFamily).toBe(true);
  });

  it("should detect when judge and agent are from different families", async () => {
    // Mock fetch implementation that returns a valid judge response
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { 
            content: '{"criteria": {"accuracy": 5, "completeness": 4}}'
          }
        }]
      })
    });

    const judge = createJudge({
      fetch: mockFetch as any,
      apiKey: "***",
      baseUrl: "http://test.local",
      model: "qwen-plus-free", // Qwen family
      timeoutMs: 10000,
    });

    // Test when agent uses a different family model
    const result = await judge.judgeTask({
      taskSlug: "test-task",
      prompt: "Test prompt",
      answer: "Test answer",
      rubric: { criteria: [{ name: "accuracy", description: "Accuracy", points: 5 }, { name: "completeness", description: "Completeness", points: 5 }] },
      kind: "general",
      agentModel: "gpt-4", // Different family
    });

    expect(result.sameFamily).toBe(false);
  });

  it("should handle missing agent model", async () => {
    // Mock fetch implementation that returns a valid judge response
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { 
            content: '{"criteria": {"accuracy": 5, "completeness": 4}}'
          }
        }]
      })
    });

    const judge = createJudge({
      fetch: mockFetch as any,
      apiKey: "***",
      baseUrl: "http://test.local",
      model: "qwen-plus-free", // Qwen family
      timeoutMs: 10000,
    });

    // Test when agent model is not provided
    const result = await judge.judgeTask({
      taskSlug: "test-task",
      prompt: "Test prompt",
      answer: "Test answer",
      rubric: { criteria: [{ name: "accuracy", description: "Accuracy", points: 5 }, { name: "completeness", description: "Completeness", points: 5 }] },
      kind: "general",
      // agentModel is undefined
    });

    expect(result.sameFamily).toBe(false);
  });

  it("should handle dashscope models", async () => {
    // Mock fetch implementation that returns a valid judge response
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: { 
            content: '{"criteria": {"accuracy": 5, "completeness": 4}}'
          }
        }]
      })
    });

    const judge = createJudge({
      fetch: mockFetch as any,
      apiKey: "***",
      baseUrl: "http://test.local",
      model: "dashscope/qwen-max", // Qwen family via dashscope/
      timeoutMs: 10000,
    });

    // Test when agent uses another dashscope model
    const result = await judge.judgeTask({
      taskSlug: "test-task",
      prompt: "Test prompt",
      answer: "Test answer",
      rubric: { criteria: [{ name: "accuracy", description: "Accuracy", points: 5 }, { name: "completeness", description: "Completeness", points: 5 }] },
      kind: "general",
      agentModel: "dashscope/qwen-plus", // Same family
    });

    expect(result.sameFamily).toBe(true);
  });
});