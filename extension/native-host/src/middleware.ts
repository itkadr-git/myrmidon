/**
 * Token-middleware abstraction. The real CryptoPro-style middleware (or any
 * other signing middleware installed on the client PC) is integrated when the
 * client connects; this part ships only the interface plus a deterministic
 * mock implementation for the part F stand.
 *
 * The middleware owns the private key and, in the "middleware owns the PIN"
 * mode, also the PIN. Neither value ever leaves the machine.
 */
import { createHash } from "node:crypto";
import type { SignActionType } from "./protocol.ts";

export interface SignDocumentInput {
  actionType: SignActionType;
  documentRef: string;
  /** Decoded document bytes (payload kind "bytes"). */
  bytes?: Buffer;
  /** Pre-computed digest when the extension sends kind "digest". */
  digest?: Buffer;
}

export interface SignMiddleware {
  readonly name: string;
  /** Signs the document; returns the digest of the signed document. */
  sign(input: SignDocumentInput): Promise<{ hashHex: string }>;
}

/**
 * Deterministic mock middleware for the part F stand: the "signature" is the
 * SHA-256 of (actionType, documentRef, document digest). It records nothing
 * and needs no PIN, so the stand can exercise the full protocol without real
 * hardware.
 */
export function createMockMiddleware(): SignMiddleware {
  return {
    name: "mock",
    async sign(input: SignDocumentInput) {
      const digest = input.digest ?? (input.bytes ? createHash("sha256").update(input.bytes).digest() : null);
      if (!digest) throw new Error("mock middleware: no document bytes or digest");
      const composed = createHash("sha256")
        .update(input.actionType)
        .update("\u0000")
        .update(input.documentRef)
        .update("\u0000")
        .update(digest)
        .digest("hex");
      return { hashHex: composed };
    },
  };
}
