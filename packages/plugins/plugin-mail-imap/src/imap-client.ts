/**
 * imapflow-backed production IMAP client.
 *
 * The client is intentionally thin: connect per sync run, fetch envelope
 * metadata only (no bodies, no attachments), move messages, disconnect.
 */

import { ImapFlow } from "imapflow";
import type { ImapClientLike } from "./sync-engine.js";
import type { MailMessageInfo } from "./rules.js";

export interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export class ImapFlowClient implements ImapClientLike {
  private client: ImapFlow;

  constructor(config: ImapConnectionConfig) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
      logger: false,
      socketTimeout: 60_000,
      greetingTimeout: 30_000,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async selectMailbox(folder: string): Promise<void> {
    await this.client.mailboxOpen(folder);
  }

  async getHighestUid(): Promise<number> {
    const mailbox = this.client.mailbox;
    if (!mailbox || typeof mailbox !== "object") return 0;
    // uidNext is the UID the next new message will get; highest assigned is uidNext-1.
    const uidNext = (mailbox as { uidNext?: number }).uidNext ?? 0;
    return uidNext > 0 ? uidNext - 1 : 0;
  }

  async listMessages(fromUid: number, toUid: number, limit: number): Promise<MailMessageInfo[]> {
    const range = `${fromUid + 1}:${toUid}`;
    const out: MailMessageInfo[] = [];
    for await (const message of this.client.fetch(
      range,
      { uid: true, envelope: true, bodyStructure: true },
      { uid: true },
    )) {
      const envelope = message.envelope;
      const from = envelope?.from?.map((addr) => addr.address ?? addr.name ?? "").filter(Boolean).join(", ") ?? "";
      const hasAttachment = hasAttachmentPart(message.bodyStructure);
      out.push({
        uid: message.uid,
        from,
        subject: envelope?.subject ?? "",
        hasAttachment,
        messageId: envelope?.messageId,
        date: envelope?.date ? envelope.date.toISOString() : undefined,
      });
      if (out.length >= limit) break;
    }
    out.sort((a, b) => a.uid - b.uid);
    return out;
  }

  async moveMessage(uid: number, targetFolder: string): Promise<void> {
    // Create the target folder if it does not exist; ignore "already exists".
    try {
      await this.client.mailboxCreate(targetFolder);
    } catch {
      // mailboxCreate throws when the folder exists — safe to ignore.
    }
    await this.client.messageMove(String(uid), targetFolder, { uid: true });
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Already closed.
    }
  }
}

function hasAttachmentPart(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const part = node as {
    disposition?: string | null;
    childNodes?: unknown[];
  };
  if (part.disposition === "attachment") return true;
  if (Array.isArray(part.childNodes)) {
    return part.childNodes.some((child) => hasAttachmentPart(child));
  }
  return false;
}
