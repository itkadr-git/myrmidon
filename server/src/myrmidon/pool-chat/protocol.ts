import { createHash } from "node:crypto";

export type PoolChatMessage = { role: "user" | "assistant"; content: string };

export type PoolChatRequestBody = {
  conversationId: string;
  clientMessageId: string;
  model: string;
  messages: PoolChatMessage[];
  maxOutputTokens?: number;
};

export type RequestValidation =
  | { valid: true; value: PoolChatRequestBody }
  | { valid: false; code: "invalid_request" | "unsupported_model" };

const allowedKeys = new Set([
  "conversationId",
  "clientMessageId",
  "model",
  "messages",
  "maxOutputTokens",
]);
const maxInputBytes = 65_536;
const maxMessages = 100;
const maxOutputTokens = 4096;

export function validateIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]{16,128}$/.test(value);
}

export function validateRequestBody(
  input: unknown,
  allowedModels: ReadonlySet<string>,
): RequestValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, code: "invalid_request" };
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return { valid: false, code: "invalid_request" };
  }
  const { conversationId, clientMessageId, model, messages, maxOutputTokens: requestedTokens } = body;
  if (
    typeof conversationId !== "string" || conversationId.length < 1 || conversationId.length > 256 ||
    typeof clientMessageId !== "string" || clientMessageId.length < 1 || clientMessageId.length > 256 ||
    typeof model !== "string" || model.length < 1 || model.length > 128 ||
    !Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages ||
    (requestedTokens !== undefined &&
      (!Number.isInteger(requestedTokens) || (requestedTokens as number) < 1 || (requestedTokens as number) > maxOutputTokens))
  ) {
    return { valid: false, code: "invalid_request" };
  }

  let previousRole: PoolChatMessage["role"] | null = null;
  let inputBytes = Buffer.byteLength(JSON.stringify({ conversationId, clientMessageId, model }), "utf8");
  const normalizedMessages: PoolChatMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { valid: false, code: "invalid_request" };
    }
    const message = raw as Record<string, unknown>;
    if (
      Object.keys(message).some((key) => key !== "role" && key !== "content") ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" || message.content.trim().length === 0
    ) {
      return { valid: false, code: "invalid_request" };
    }
    const role = message.role;
    if (role === previousRole || (previousRole === null && role !== "user")) {
      return { valid: false, code: "invalid_request" };
    }
    previousRole = role;
    inputBytes += Buffer.byteLength(message.content, "utf8") + Buffer.byteLength(role, "utf8");
    if (inputBytes > maxInputBytes) return { valid: false, code: "invalid_request" };
    normalizedMessages.push({ role, content: message.content });
  }
  if (normalizedMessages[normalizedMessages.length - 1]?.role !== "user") {
    return { valid: false, code: "invalid_request" };
  }
  if (!allowedModels.has(model)) return { valid: false, code: "unsupported_model" };

  return {
    valid: true,
    value: {
      conversationId,
      clientMessageId,
      model,
      messages: normalizedMessages,
      maxOutputTokens: (requestedTokens as number | undefined) ?? 2048,
    },
  };
}

export function canonicalRequestHash(value: PoolChatRequestBody): string {
  const canonical = JSON.stringify({
    conversationId: value.conversationId,
    clientMessageId: value.clientMessageId,
    model: value.model,
    messages: value.messages.map(({ role, content }) => ({ role, content })),
    maxOutputTokens: value.maxOutputTokens ?? 2048,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
