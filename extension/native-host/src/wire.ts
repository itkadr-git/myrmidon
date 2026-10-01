/**
 * Chrome Native Messaging wire format: a message is a UTF-8 JSON object
 * prefixed with a 4-byte little-endian length. The host speaks this over
 * stdio with the browser only.
 */
import type { InboundMessage, SignResponseMessage } from "./protocol.ts";

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024; // Chrome allows up to 64 MiB from the host.

/** Encodes a message to the Chrome native-messaging wire format. */
export function encodeMessage(message: SignResponseMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_MESSAGE_BYTES) throw new Error(`message too large: ${json.length}`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Incremental decoder for the framing on an inbound stream. */
export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  /** Feed raw bytes; returns every complete message decoded in order. */
  push(chunk: Buffer): InboundMessage[] {
    const combined = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.buffer = Buffer.from(combined);
    const messages: InboundMessage[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_MESSAGE_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`invalid message length: ${length}`);
      }
      if (this.buffer.length < 4 + length) break;
      const json = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(json) as InboundMessage);
    }
    return messages;
  }
}
