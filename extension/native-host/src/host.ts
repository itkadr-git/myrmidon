/**
 * The host loop. Accepts sign commands from the extension over Chrome native
 * messaging (stdio), invokes the token-middleware abstraction, answers with
 * {ok:true,hash} or {ok:false,error}. The host has no network interfaces: the
 * only channel is the stdio pipe the browser opened, and the browser only
 * launches hosts whose manifest allowed_origins matches the extension ID.
 */
import type { SignMiddleware, SignDocumentInput } from "./middleware.ts";
import { isSignRequestMessage, type SignRequestMessage, type SignResponseMessage } from "./protocol.ts";
import { NativeMessageDecoder, encodeMessage } from "./wire.ts";

export interface HostStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface HostOptions {
  middleware: SignMiddleware;
  /** Rejects every sign command when true (bridge-level kill switch mirror). */
  disabled?: boolean;
  onResult?(documentRef: string, result: { hash?: string; error?: string }): void;
}

export function errorResponse(id: number, code: string, message?: string): SignResponseMessage {
  return { type: "sign_result", id, result: { ok: false, error: code as never, message } };
}

/** Handles a single validated request; exposed for tests. */
export async function handleSignRequest(
  request: SignRequestMessage,
  options: HostOptions,
): Promise<SignResponseMessage> {
  const documentInput: SignDocumentInput = {
    actionType: request.actionType,
    documentRef: request.documentRef,
    ...(request.document.kind === "bytes"
      ? { bytes: Buffer.from(request.document.bytesBase64, "base64") }
      : { digest: Buffer.from(request.document.digestHex, "hex") }),
  };
  try {
    if (options.disabled) {
      return errorResponse(request.id, "cancelled", "signing disabled");
    }
    const { hashHex } = await options.middleware.sign(documentInput);
    const result: SignResponseMessage = { type: "sign_result", id: request.id, result: { ok: true, hash: hashHex } };
    options.onResult?.(request.documentRef, { hash: hashHex });
    return result;
  } catch (error) {
    const code = (error as { code?: string }).code === "pin_unavailable" ? "pin_unavailable" : "middleware_error";
    const message = error instanceof Error ? error.message : String(error);
    options.onResult?.(request.documentRef, { error: code });
    return errorResponse(request.id, code, message);
  }
}

/** Decodes, validates and dispatches one raw JSON value. */
export async function dispatchRaw(raw: unknown, options: HostOptions): Promise<SignResponseMessage | null> {
  if (!isSignRequestMessage(raw)) {
    // Unknown or malformed messages are dropped: the protocol has no request
    // id to answer to, so silence is the only safe reply.
    if (typeof raw === "object" && raw !== null && "id" in raw) {
      return errorResponse((raw as { id: number }).id, "invalid_request", "malformed sign request");
    }
    return null;
  }
  return handleSignRequest(raw, options);
}

/** Runs the host loop over stdio until the browser closes the input. */
export function runHost(streams: HostStreams, options: HostOptions): void {
  const decoder = new NativeMessageDecoder();
  streams.input.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      // A framing error means the stream is not native messaging; drop it.
      return;
    }
    void (async () => {
      for (const raw of messages) {
        let response: SignResponseMessage | null = null;
        try {
          response = await dispatchRaw(raw, options);
        } catch {
          response = null;
        }
        if (response) writeResponse(streams, response);
      }
    })();
  });
}

export function writeResponse(streams: HostStreams, response: SignResponseMessage): void {
  streams.output.write(encodeMessage(response));
}
