import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatToolOutputTruncationNotice,
  resolveToolOutputLimit,
  truncateToolOutputText,
} from "@myrmidon/shared";
import { applyToolOutputLimit } from "./tool-output-limit.js";

describe("myrmidon(1.6.7-TOKENS-TOOL-OUTPUT, OPE-10730) tool output limit", () => {
  describe("resolveToolOutputLimit", () => {
    it("returns null when no settings or overrides are specified", () => {
      expect(resolveToolOutputLimit({})).toBeNull();
    });

    it("reads instance general setting toolOutputChars", () => {
      expect(
        resolveToolOutputLimit({
          instanceSettings: { toolOutputChars: 5000 },
        }),
      ).toBe(5000);
    });

    it("reads instance general setting toolOutputLimit.maxChars", () => {
      expect(
        resolveToolOutputLimit({
          instanceSettings: {
            toolOutputLimit: { enabled: true, maxChars: 8000 },
          },
        }),
      ).toBe(8000);
    });

    it("ignores instance setting when enabled is false", () => {
      expect(
        resolveToolOutputLimit({
          instanceSettings: {
            toolOutputLimit: { enabled: false, maxChars: 8000 },
          },
        }),
      ).toBeNull();
    });

    it("prioritizes agent card override toolOutputChars over instance settings", () => {
      expect(
        resolveToolOutputLimit({
          instanceSettings: { toolOutputChars: 10000 },
          agentCardConfig: { toolOutputChars: 2500 },
        }),
      ).toBe(2500);
    });

    it("supports snake_case tool_output_chars from agent card (DreamTeam spec compatibility)", () => {
      expect(
        resolveToolOutputLimit({
          instanceSettings: { toolOutputChars: 10000 },
          agentCardConfig: { tool_output_chars: 1500 },
        }),
      ).toBe(1500);
    });

    it("falls back to environment variable when instance settings are absent", () => {
      expect(
        resolveToolOutputLimit({
          env: { MYRMIDON_TOOL_OUTPUT_MAX_CHARS: "4000" } as any,
        }),
      ).toBe(4000);
    });
  });

  describe("truncateToolOutputText and notice format", () => {
    it("preserves text under the limit without truncation", () => {
      const shortText = "small tool output";
      const result = truncateToolOutputText({
        text: shortText,
        maxChars: 100,
        fullTextPath: "/tmp/trace.txt",
      });
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(shortText);
      expect(result.shownChars).toBe(shortText.length);
      expect(result.totalChars).toBe(shortText.length);
    });

    it("truncates text over the limit and formats the required Russian notice", () => {
      const longText = "A".repeat(500);
      const limit = 200;
      const fullPath = "/workspace/.myrmidon/traces/tool-output-123.txt";

      const notice = formatToolOutputTruncationNotice(limit, longText.length, fullPath);
      expect(notice).toBe("показано 200 из 500 символов, полный текст — /workspace/.myrmidon/traces/tool-output-123.txt");

      const result = truncateToolOutputText({
        text: longText,
        maxChars: limit,
        fullTextPath: fullPath,
      });

      expect(result.truncated).toBe(true);
      expect(result.shownChars).toBe(200);
      expect(result.totalChars).toBe(500);
      expect(result.text).toContain("показано 200 из 500 символов, полный текст — /workspace/.myrmidon/traces/tool-output-123.txt");
      expect(result.text.startsWith("A".repeat(200))).toBe(true);
    });
  });

  describe("applyToolOutputLimit execution and trace file persistence", () => {
    it("writes full text to trace file and truncates content in result record", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-limit-test-"));
      try {
        const fullContent = "Line 1\n".repeat(100); // 700 chars
        const maxChars = 140;

        const outcome = applyToolOutputLimit({
          result: {
            content: fullContent,
            data: { test: true },
          },
          invocationId: "inv-999",
          runId: "run-456",
          workspaceDir: tmpDir,
          agentCardConfig: { toolOutputChars: maxChars },
        });

        expect(outcome.truncated).toBe(true);
        expect(outcome.shownChars).toBe(140);
        expect(outcome.totalChars).toBe(fullContent.length);
        expect(outcome.fullTextPath).toBeDefined();

        // Verify full text was actually written to the trace file
        expect(fs.existsSync(outcome.fullTextPath!)).toBe(true);
        const writtenText = fs.readFileSync(outcome.fullTextPath!, "utf8");
        expect(writtenText).toBe(fullContent);

        // Verify the model-facing result contains the Russian marker with the path
        const resultRecord = outcome.result as Record<string, unknown>;
        expect(typeof resultRecord.content).toBe("string");
        expect((resultRecord.content as string).includes(`показано 140 из ${fullContent.length} символов, полный текст — ${outcome.fullTextPath}`)).toBe(true);
        expect(resultRecord.data).toEqual({ test: true });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("truncates string result and saves full text to trace directory", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-limit-string-test-"));
      try {
        const fullContent = "B".repeat(1000);
        const maxChars = 250;

        const outcome = applyToolOutputLimit({
          result: fullContent,
          invocationId: "inv-str-1",
          workspaceDir: tmpDir,
          instanceSettings: { toolOutputChars: maxChars },
        });

        expect(outcome.truncated).toBe(true);
        expect(typeof outcome.result).toBe("string");
        expect((outcome.result as string).includes(`показано 250 из 1000 символов, полный текст — ${outcome.fullTextPath}`)).toBe(true);
        expect(fs.readFileSync(outcome.fullTextPath!, "utf8")).toBe(fullContent);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
