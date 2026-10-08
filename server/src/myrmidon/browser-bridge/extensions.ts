// myrmidon(EXTCASE-B): extension request types of the browser bridge.
//
// The bridge already holds an authenticated, company-bound, outbound-only
// session per connected client (WSS + the device's bridge token). This file is
// the generic extension point on top of that session: a private connector
// registers a *request type* — a namespaced JSON-RPC method — and then
//
// - sends requests of that type to a client session of a company
//   (`send`: board -> client, one request, one answer), and/or
// - handles requests of that type that the client sends to the board
//   (`handler`: client -> board, answered on the same session).
//
// The registry knows nothing about what a type carries. It enforces only the
// things that belong to the transport:
//
// - a type is `ext.<name>`: it cannot collide with `bridge.*` or `browser.*`;
// - a request only ever reaches a session of the company it names, never
//   another company's device (the session is the isolation boundary);
// - an unregistered type is refused (-32601) instead of being forwarded;
// - the payload is never journaled or logged here — only the type and the
//   outcome are visible to a caller.

import { BROWSER_BRIDGE_ERROR_CODES } from "@paperclipai/shared";
import type { InMemoryBridgeSessionRegistry, BridgeSession } from "./sessions.js";
import { BrowserBridgeError } from "./service.js";

/** The namespace every extension request type lives in. */
export const BRIDGE_EXTENSION_PREFIX = "ext.";

/** Default wait for the client's answer to one extension request. */
export const BRIDGE_EXTENSION_DEFAULT_TIMEOUT_MS = 30_000;
/** No extension request waits longer than this, whatever the type asks. */
export const BRIDGE_EXTENSION_MAX_TIMEOUT_MS = 180_000;

const TYPE_PATTERN = /^ext\.[a-z][a-z0-9_-]{0,63}(\.[a-z][a-z0-9_-]{0,63}){0,3}$/;

/** True when `value` is a well-formed extension request type. */
export function isBridgeExtensionType(value: unknown): value is string {
  return typeof value === "string" && TYPE_PATTERN.test(value);
}

/** Who is calling a handler: the authenticated session, never the payload. */
export interface BridgeExtensionCaller {
  companyId: string;
  deviceId: string;
}

export interface BridgeExtensionDefinition {
  /** Wait for the client's answer, clamped to `BRIDGE_EXTENSION_MAX_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Handles a request of this type that the client sends to the board. The
   * returned value is the answer; a thrown `BrowserBridgeError` is answered
   * as that JSON-RPC error, any other throw as an internal error.
   */
  handler?(caller: BridgeExtensionCaller, params: unknown): Promise<unknown> | unknown;
}

export interface BridgeExtensionSendInput {
  companyId: string;
  type: string;
  params?: unknown;
  /** Target one device of the company; default: its most recently connected session. */
  deviceId?: string;
  /** Narrow the candidate sessions further (e.g. by client version). */
  select?(session: BridgeSession): boolean;
  timeoutMs?: number;
}

export interface BridgeExtensionRegistry {
  /** Register a type; registering the same type twice is a programming error. */
  register(type: string, definition?: BridgeExtensionDefinition): void;
  has(type: string): boolean;
  /** Send one request to a client session of the company and await its answer. */
  send(input: BridgeExtensionSendInput): Promise<unknown>;
  /**
   * Answer one client-to-board request of a registered type; `undefined` when
   * the type is unknown or has no handler (the caller then refuses as unknown).
   */
  handle(type: string, caller: BridgeExtensionCaller, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }> | undefined;
}

export function createBridgeExtensionRegistry(sessions: InMemoryBridgeSessionRegistry): BridgeExtensionRegistry {
  const definitions = new Map<string, BridgeExtensionDefinition>();

  function register(type: string, definition: BridgeExtensionDefinition = {}): void {
    if (!isBridgeExtensionType(type)) {
      throw new Error(`bridge extension type must look like "ext.<name>": ${String(type)}`);
    }
    if (definitions.has(type)) throw new Error(`bridge extension type is already registered: ${type}`);
    definitions.set(type, { ...definition });
  }

  async function send(input: BridgeExtensionSendInput): Promise<unknown> {
    const definition = definitions.get(input.type);
    if (!definition) {
      throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.methodNotFound, `unknown extension type ${input.type}`);
    }
    const candidates = sessions
      .listForCompany(input.companyId)
      .filter((session) => (input.deviceId ? session.deviceId === input.deviceId : true))
      .filter((session) => (input.select ? input.select(session) : true))
      .sort((a, b) => b.connectedAt - a.connectedAt);
    const target = candidates[0];
    if (!target) {
      throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.deviceOffline, "no connected client session for this company");
    }
    const wanted = input.timeoutMs ?? definition.timeoutMs ?? BRIDGE_EXTENSION_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1, Math.min(wanted, BRIDGE_EXTENSION_MAX_TIMEOUT_MS));
    return target.request(input.type, input.params ?? {}, timeoutMs);
  }

  function handle(type: string, caller: BridgeExtensionCaller, params: unknown) {
    const definition = definitions.get(type);
    if (!definition?.handler) return undefined;
    const handler = definition.handler;
    return (async () => {
      try {
        return { ok: true as const, result: await handler(caller, params) };
      } catch (err) {
        if (err instanceof BrowserBridgeError) return { ok: false as const, code: err.reasonCode, message: err.message };
        return { ok: false as const, code: BROWSER_BRIDGE_ERROR_CODES.internalError, message: "extension handler failed" };
      }
    })();
  }

  return { register, has: (type) => definitions.has(type), send, handle };
}
