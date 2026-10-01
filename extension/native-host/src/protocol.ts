/**
 * Native messaging protocol shared between the extension (part C/D) and the
 * local Windows signing helper (this package, part H).
 *
 * Wire format is Chrome Native Messaging: each message is a UTF-8 JSON object
 * prefixed with a 4-byte little-endian length. The PIN and the private key
 * NEVER cross this boundary and never reach our servers or the model: only
 * the command below and the result cross it.
 */

/** Allowed sign operations (mirrors the board's sign action types). */
export const SIGN_ACTION_TYPES = [
  "sign",
  "sign_and_submit",
  "sign_attachment",
] as const;

export type SignActionType = (typeof SIGN_ACTION_TYPES)[number];

export function isSignActionType(value: unknown): value is SignActionType {
  return typeof value === "string" && (SIGN_ACTION_TYPES as readonly string[]).includes(value);
}

/** Command from the extension to the helper: documentRef refers to a file in the bot workspace. */
export interface SignCommand {
  actionType: SignActionType;
  documentRef: string;
}

/**
 * Document bytes or a digest of them. The helper never persists the document:
 * the extension downloads/reads the document and passes either raw bytes or a
 * pre-computed hash (the exact variant is part of the D<->H contract, decided
 * in part D).
 */
export type DocumentPayload =
  | { kind: "bytes"; bytesBase64: string }
  | { kind: "digest"; digestHex: string };

export interface SignRequestMessage {
  type: "sign";
  id: number;
  actionType: SignActionType;
  documentRef: string;
  document: DocumentPayload;
}

export interface SignSuccess {
  ok: true;
  /** Hex digest of the signed document (what the journal records). */
  hash: string;
}

export interface SignFailure {
  ok: false;
  error: SignErrorCode;
  message?: string;
}

export const SIGN_ERROR_CODES = [
  "invalid_request",
  "unknown_action_type",
  "unsupported_payload",
  "pin_unavailable",
  "middleware_error",
  "cancelled",
] as const;

export type SignErrorCode = (typeof SIGN_ERROR_CODES)[number];

export type SignResult = SignSuccess | SignFailure;

export interface SignResponseMessage {
  type: "sign_result";
  id: number;
  result: SignResult;
}

export type InboundMessage = SignRequestMessage;

export function isSignRequestMessage(value: unknown): value is SignRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "sign" &&
    typeof v.id === "number" &&
    Number.isFinite(v.id) &&
    isSignActionType(v.actionType) &&
    typeof v.documentRef === "string" &&
    v.documentRef.length > 0 &&
    isDocumentPayload(v.document)
  );
}

export function isDocumentPayload(value: unknown): value is DocumentPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "bytes") return typeof v.bytesBase64 === "string" && v.bytesBase64.length > 0;
  if (v.kind === "digest") return typeof v.digestHex === "string" && /^[0-9a-f]{64}$/i.test(v.digestHex);
  return false;
}
