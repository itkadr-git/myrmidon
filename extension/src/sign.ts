// The signing step of the bridge (`browser.sign`).
//
// The extension never holds a key or a PIN. It fetches the document in the
// page session, hands the bytes to the local signing helper over Chrome
// native messaging, and reports only the status and the document digest to the
// gateway. The helper drives the CryptoPro CSP (CAdESCOM) installed on the
// same PC; the detached signature stays in the browser profile, in a small
// in-memory stash for the page, and never crosses the bridge.

import {
  SIGN_ACTION_TYPES,
  SIGN_HOST_NAME,
  isSignResponseMessage,
  type SignActionType,
  type SignErrorCode,
  type SignRequestMessage,
} from "./native-host-contract";

/** Time budget of one helper call: the CSP may be waiting for a PIN. */
export const SIGN_HELPER_TIMEOUT_MS = 120_000;

export interface SignHelperRequest {
  actionType: SignActionType;
  documentRef: string;
  /** Document bytes, base64. */
  bytesBase64: string;
}

export type SignHelperOutcome =
  | { ok: true; hash: string; signatureBase64?: string }
  | { ok: false; error: SignErrorCode | "helper_unavailable"; message?: string };

/** The helper as the action dispatcher sees it. */
export interface SignHelperPort {
  sign(request: SignHelperRequest): Promise<SignHelperOutcome>;
}

/** Where a produced signature waits for the page (client PC memory only). */
export interface SignatureStash {
  put(documentHash: string, signatureBase64: string): void;
  take(documentHash: string): string | null;
}

export function isHelperActionType(value: unknown): value is SignActionType {
  return typeof value === "string" && (SIGN_ACTION_TYPES as readonly string[]).includes(value);
}

/** Bounded in-memory stash: the oldest signature is dropped first. */
export function createSignatureStash(limit = 8): SignatureStash {
  const items = new Map<string, string>();
  return {
    put(documentHash, signatureBase64) {
      items.delete(documentHash);
      items.set(documentHash, signatureBase64);
      while (items.size > limit) {
        const oldest = items.keys().next().value;
        if (oldest === undefined) break;
        items.delete(oldest);
      }
    },
    take(documentHash) {
      const value = items.get(documentHash) ?? null;
      items.delete(documentHash);
      return value;
    },
  };
}

/** Transport of one native message: `chrome.runtime.sendNativeMessage` in the build. */
export type NativeMessageSender = (host: string, message: unknown) => Promise<unknown>;

export interface TimerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The helper client over native messaging. Answers are validated, never trusted. */
export function createNativeSignHelper(
  send: NativeMessageSender,
  options: { hostName?: string; timeoutMs?: number; timers?: TimerLike; nextId?: () => number } = {},
): SignHelperPort {
  const hostName = options.hostName ?? SIGN_HOST_NAME;
  const timeoutMs = options.timeoutMs ?? SIGN_HELPER_TIMEOUT_MS;
  const timers: TimerLike = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let seq = 0;
  const nextId = options.nextId ?? (() => (seq += 1));

  return {
    async sign(request) {
      const id = nextId();
      const message: SignRequestMessage = {
        type: "sign",
        id,
        actionType: request.actionType,
        documentRef: request.documentRef,
        document: { kind: "bytes", bytesBase64: request.bytesBase64 },
      };
      let handle: unknown;
      try {
        const answer = await Promise.race([
          send(hostName, message),
          new Promise<never>((_, reject) => {
            handle = timers.setTimeout(() => reject(new Error("the signing helper did not answer in time")), timeoutMs);
          }),
        ]);
        if (!isSignResponseMessage(answer, id)) {
          return { ok: false, error: "helper_unavailable", message: "the helper answered with an unreadable message" };
        }
        const result = answer.result;
        if (result.ok) {
          return {
            ok: true,
            hash: result.hash,
            ...(result.signatureBase64 ? { signatureBase64: result.signatureBase64 } : {}),
          };
        }
        return { ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) };
      } catch (err) {
        // sendNativeMessage rejects when the host is not registered, the
        // extension is not allowed by its manifest, or the host exits early.
        return { ok: false, error: "helper_unavailable", message: String((err as Error)?.message ?? err) };
      } finally {
        if (handle !== undefined) timers.clearTimeout(handle);
      }
    },
  };
}
