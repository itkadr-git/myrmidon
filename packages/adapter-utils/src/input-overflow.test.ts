import { describe, expect, it } from "vitest";
import { classifyInputOverflow } from "./input-overflow.js";

describe("classifyInputOverflow", () => {
  const rows: Array<[string, string, string]> = [
    ["dashscope", "InternalError.Algo.InvalidParameter: Range of input length should be [1, 1048576]", "dashscope"],
    ["openai code", "Error code: 400 - {'error': {'code': 'context_length_exceeded'}}", "openai"],
    ["openai text", "This model's maximum context length is 128000 tokens. However, your messages resulted in 300000 tokens.", "openai"],
    ["anthropic", "invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum", "anthropic"],
    ["gemini", "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)", "gemini"],
    ["generic window", "request exceeds the model's context window", "generic"],
    ["generic too long", "Input is too long for requested model", "generic"],
  ];
  for (const [name, text, provider] of rows) {
    it(`matches ${name}`, () => {
      expect(classifyInputOverflow(text)?.provider).toBe(provider);
    });
  }

  it("ignores unrelated failures", () => {
    expect(classifyInputOverflow("429 rate limited", "connection reset")).toBeNull();
    expect(classifyInputOverflow(null, undefined)).toBeNull();
  });
});
