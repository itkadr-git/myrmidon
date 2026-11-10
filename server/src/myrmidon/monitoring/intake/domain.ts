// server/src/myrmidon/monitoring/intake/domain.ts
// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): pure functions of the intake —
// signature verification, event-id extraction, and the dedup decision. No db,
// no express: everything here is unit-testable without a server.
//
// Signature model (matches the Paperclip signed-trigger modes): the sender
// knows a shared secret; `hmac_sha256` signs the exact request bytes and sends
// `sha256=<hex>` either in the configured header or in the Authorization
// header. Verification is constant-time; the secret value is never logged or
// returned. The raw body is stored verbatim as a draft candidate — content is
// NOT interpreted or routed here (routing is the next slice).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_INTAKE_SIGNATURE_SCHEME = "hmac_sha256" as const;
export const WEBHOOK_INTAKE_SIGNATURE_HEADER = "x-myrmidon-signature-256";

export type IntakeSource = string;

/** A parsed inbound webhook delivery, ready to be stored as a draft. */
export interface IntakeDelivery {
  source: IntakeSource;
  externalEventId: string;
  eventType: string | null;
}

/** What the route should do with this delivery. */
export type IntakeDecision =
  | { action: "store"; delivery: IntakeDelivery }
  | { action: "duplicate"; delivery: IntakeDelivery }
  | { action: "reject"; reason: string };

export interface SignatureParts {
  scheme: "hmac_sha256";
  /** The signed payload: the exact request bytes. */
  body: Buffer;
  /** `sha256=<hex>` header value as received. */
  signatureHeader: string | null;
  signatureHeaderValue: string | null;
}

/**
 * Constant-time HMAC-SHA256 verification of the raw body. Accepts the
 * `sha256=<hex>` form (GitHub/Hermes style); comparison is timing-safe and
 * never depends on payload content.
 */
export function verifyHmacSha256(parts: SignatureParts, secret: string): boolean {
  if (!secret || !parts.signatureHeaderValue) return false;
  const provided = parts.signatureHeaderValue.trim();
  const expected = "sha256=" + createHmac("sha256", secret).update(parts.body).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function pickHeader(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The event identity of a delivery. Explicit fields win; known provider
 * headers are the fallback; a SHA-256 of the raw body is the last resort so
 * that even header-less custom senders still dedupe by content.
 */
export function extractDelivery(
  source: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  rawBody?: Buffer | string,
): IntakeDelivery {
  const explicit = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const rawId =
    (typeof explicit?.eventId === "string" && explicit.eventId) ||
    (typeof explicit?.deliveryId === "string" && explicit.deliveryId) ||
    (typeof explicit?.id === "string" && explicit.id) ||
    pickHeader(headers, "x-myrmidon-delivery") ||
    pickHeader(headers, "x-github-delivery") ||
    pickHeader(headers, "x-delivery-id") ||
    null;
  const fallbackContent =
    rawBody !== undefined
      ? rawBody
      : typeof body === "string" || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body ?? null);
  const externalEventId = rawId ?? sha256Hex(fallbackContent);
  const eventType =
    (typeof explicit?.eventType === "string" && explicit.eventType) ||
    pickHeader(headers, "x-myrmidon-event") ||
    pickHeader(headers, "x-github-event") ||
    pickHeader(headers, "x-event-type") ||
    null;
  return {
    source: normalizeSource(source),
    externalEventId,
    eventType: eventType ?? null,
  };
}

export function normalizeSource(source: string): string {
  const trimmed = source.trim().toLowerCase();
  if (!trimmed) throw new Error("webhook intake source must be a non-empty string");
  if (trimmed.length > 100) throw new Error("webhook intake source must be at most 100 characters");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    throw new Error("webhook intake source must match [a-z0-9][a-z0-9._-]*");
  }
  return trimmed;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Pure dedup decision: what the store result means for the route. */
export function decideIntake(stored: "created" | "existing"): "store" | "duplicate" {
  return stored === "created" ? "store" : "duplicate";
}
