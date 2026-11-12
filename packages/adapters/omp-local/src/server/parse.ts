import { asNumber, asString, parseJson } from "@myrmidon/adapter-utils/server-utils";

export interface ParsedOmpOutput {
  sessionId: string | null;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  };
  finalMessage: string | null;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown; result: string | null; isError: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

export function parseOmpJsonl(stdout: string): ParsedOmpOutput {
  const result: ParsedOmpOutput = {
    sessionId: null,
    messages: [],
    errors: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    },
    finalMessage: null,
    toolCalls: [],
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event.type, "");

    // Terminal assistant message error detection
    const terminalMessages = eventType === "agent_end"
      ? (Array.isArray(event.messages) ? event.messages : [])
      : eventType === "message_end" || eventType === "turn_end"
        ? [event.message]
        : [];
    for (const rawMessage of terminalMessages) {
      const message = asRecord(rawMessage);
      if (message?.role !== "assistant" || message.stopReason !== "error") continue;
      const error = asString(message.errorMessage, "").trim() || "OMP provider request failed.";
      if (!result.errors.includes(error)) result.errors.push(error);
    }

    // Skip internal RPC events
    if (eventType === "response" || eventType === "extension_ui_request" || eventType === "extension_ui_response" || eventType === "extension_error") {
      continue;
    }

    if (eventType === "agent_start") {
      continue;
    }

    if (eventType === "agent_end") {
      const messages = event.messages as Array<Record<string, unknown>> | undefined;
      if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "assistant") {
          const content = lastMessage.content as string | Array<{ type: string; text?: string }>;
          result.finalMessage = extractTextContent(content);
        }
      }
      continue;
    }

    if (eventType === "auto_retry_end") {
      const succeeded = event.success === true;
      if (!succeeded) {
        const finalError = asString(event.finalError, "").trim();
        result.errors.push(finalError || "OMP exhausted automatic retries without producing a response.");
      }
      continue;
    }

    if (eventType === "turn_start") {
      continue;
    }

    if (eventType === "turn_end") {
      const message = asRecord(event.message);
      if (message) {
        const content = message.content as string | Array<{ type: string; text?: string }>;
        const text = extractTextContent(content);
        if (text) {
          result.finalMessage = text;
          result.messages.push(text);
        }

        const usage = asRecord(message.usage);
        if (usage) {
          result.usage.inputTokens += asNumber(usage.input ?? usage.inputTokens, 0);
          result.usage.outputTokens += asNumber(usage.output ?? usage.outputTokens, 0);
          result.usage.cachedInputTokens += asNumber(usage.cacheRead ?? usage.cachedInputTokens, 0);

          const cost = asRecord(usage.cost);
          if (cost) {
            result.usage.costUsd += asNumber(cost.total ?? usage.costUsd, 0);
          } else {
            result.usage.costUsd += asNumber(usage.costUsd, 0);
          }
        }
      }

      const toolResults = event.toolResults as Array<Record<string, unknown>> | undefined;
      if (toolResults) {
        for (const tr of toolResults) {
          const toolCallId = asString(tr.toolCallId, "");
          const content = tr.content;
          const isError = tr.isError === true;

          const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
          if (existingCall) {
            existingCall.result = typeof content === "string" ? content : JSON.stringify(content);
            existingCall.isError = isError;
          }
        }
      }
      continue;
    }

    if (eventType === "message_update") {
      const assistantEvent = asRecord(event.assistantMessageEvent);
      if (assistantEvent) {
        const msgType = asString(assistantEvent.type, "");
        if (msgType === "text_delta") {
          const delta = asString(assistantEvent.delta, "");
          if (delta) {
            if (result.messages.length === 0) {
              result.messages.push(delta);
            } else {
              result.messages[result.messages.length - 1] += delta;
            }
          }
        }
      }
      continue;
    }

    if (eventType === "error") {
      const message = asString(event.message, "").trim();
      if (message) {
        result.errors.push(message);
      }
      continue;
    }

    if (eventType === "tool_execution_start") {
      const toolCallId = asString(event.toolCallId, "");
      const toolName = asString(event.toolName, "");
      const args = event.args;
      result.toolCalls.push({
        toolCallId,
        toolName,
        args,
        result: null,
        isError: false,
      });
      continue;
    }

    if (eventType === "tool_execution_end") {
      const toolCallId = asString(event.toolCallId, "");
      const toolResult = event.result;
      const isError = event.isError === true;

      const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
      if (existingCall) {
        existingCall.result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        existingCall.isError = isError;
      }
      continue;
    }

    if (eventType === "usage" || event.usage) {
      const usage = asRecord(event.usage);
      if (usage) {
        result.usage.inputTokens += asNumber(usage.inputTokens ?? usage.input, 0);
        result.usage.outputTokens += asNumber(usage.outputTokens ?? usage.output, 0);
        result.usage.cachedInputTokens += asNumber(usage.cachedInputTokens ?? usage.cacheRead, 0);

        const cost = asRecord(usage.cost);
        if (cost) {
          result.usage.costUsd += asNumber(cost.total ?? usage.costUsd, 0);
        } else {
          result.usage.costUsd += asNumber(usage.costUsd, 0);
        }
      }
    }
  }

  return result;
}

// myrmidon(OPE-12806): a run whose tool calls were rejected is not a success.
//
// omp exits 0 when the model gives up after its tool calls failed, so a run in
// which every shell command was refused ("Service mode does not accept async
// or timeout...") was recorded as succeeded, and the board then blocked the
// issue with successful_run_missing_state. The adapter reports such a run as
// failed with its own error code.
export const OMP_TOOL_CALLS_REJECTED_ERROR_CODE = "omp_tool_calls_rejected";

// A single tool counts as rejected when it finished at least this many calls
// and every one of them ended with an error. One or two failed calls of a tool
// are ordinary work (a wrong path, a failed edit that is then redone).
export const OMP_REJECTED_TOOL_MIN_CALLS = 3;

export interface OmpToolRejectionSummary {
  /** Tool calls that finished (have a result). */
  finishedCalls: number;
  /** Finished calls that ended with an error. */
  rejectedCalls: number;
  /** True when at least one call finished and every finished call ended with an error. */
  allRejected: boolean;
  /** Tools with >= OMP_REJECTED_TOOL_MIN_CALLS finished calls, all ended with an error. */
  rejectedTools: Array<{ toolName: string; calls: number; sampleError: string }>;
  message: string;
}

function toolErrorText(result: string | null): string {
  if (!result) return "";
  let text = result;
  const parsed = parseJson(result);
  const content = parsed ? (parsed as Record<string, unknown>).content : null;
  if (Array.isArray(content)) {
    text = content
      .map((part) => (asRecord(part)?.type === "text" ? asString(asRecord(part)?.text, "") : ""))
      .join("");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Returns a summary when the run's tool calls were rejected: either every
 * finished call ended with an error, or some tool finished at least
 * OMP_REJECTED_TOOL_MIN_CALLS calls and none of them succeeded. Returns null
 * otherwise (including a run without tool calls).
 */
export function summarizeOmpToolRejections(
  toolCalls: ParsedOmpOutput["toolCalls"],
): OmpToolRejectionSummary | null {
  const finished = toolCalls.filter((call) => call.result !== null);
  if (finished.length === 0) return null;

  const byTool = new Map<string, { calls: number; rejected: number; sampleError: string }>();
  for (const call of finished) {
    const entry = byTool.get(call.toolName) ?? { calls: 0, rejected: 0, sampleError: "" };
    entry.calls += 1;
    if (call.isError) {
      entry.rejected += 1;
      if (!entry.sampleError) entry.sampleError = toolErrorText(call.result);
    }
    byTool.set(call.toolName, entry);
  }

  const rejectedCalls = finished.filter((call) => call.isError).length;
  const allRejected = rejectedCalls === finished.length;
  const rejectedTools = [...byTool.entries()]
    .filter(([, entry]) => entry.calls >= OMP_REJECTED_TOOL_MIN_CALLS && entry.rejected === entry.calls)
    .map(([toolName, entry]) => ({ toolName, calls: entry.calls, sampleError: entry.sampleError }));

  if (!allRejected && rejectedTools.length === 0) return null;

  const sample =
    rejectedTools[0]?.sampleError ||
    [...byTool.values()].find((entry) => entry.sampleError)?.sampleError ||
    "";
  const scope = allRejected
    ? `all ${finished.length} tool call(s) were rejected`
    : rejectedTools.map((tool) => `all ${tool.calls} "${tool.toolName}" call(s) were rejected`).join("; ");
  return {
    finishedCalls: finished.length,
    rejectedCalls,
    allRejected,
    rejectedTools,
    message: `OMP finished, but ${scope}${sample ? `: ${sample}` : "."}`,
  };
}

export function isOmpUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i.test(haystack);
}
