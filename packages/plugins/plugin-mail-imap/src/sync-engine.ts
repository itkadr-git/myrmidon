/**
 * Minimal IMAP client interface so the sync engine is testable without a
 * network. The production implementation wraps imapflow.
 */

import type { MailMessageInfo } from "./rules.js";

export interface ImapClientLike {
  /** Connect and authenticate. */
  connect(): Promise<void>;
  /** Select a mailbox for reading (read-write so MOVE works). */
  selectMailbox(folder: string): Promise<void>;
  /** Highest UID currently present in the selected mailbox (0 when empty). */
  getHighestUid(): Promise<number>;
  /** List messages with UID in (fromUid, toUid], ascending. */
  listMessages(fromUid: number, toUid: number, limit: number): Promise<MailMessageInfo[]>;
  /** Move one message by UID to a target folder, creating it when missing. */
  moveMessage(uid: number, targetFolder: string): Promise<void>;
  /** Best-effort disconnect. */
  close(): Promise<void>;
}

export interface SyncRunResult {
  fetched: number;
  moved: number;
  skipped: number;
  errors: number;
  /** Highest UID seen during the run (new cursor), or null when nothing was seen. */
  highestUidSeen: number | null;
  details: Array<{
    uid: number;
    from: string;
    subject: string;
    messageId?: string;
    targetFolder: string | null;
    ruleName: string | null;
    status: "moved" | "kept" | "error";
    error?: string;
  }>;
}

export interface SyncEngineDeps {
  client: ImapClientLike;
  rules: readonly import("./rules.js").MailSortRule[];
  defaultTargetFolder?: string;
  sourceFolder: string;
  lastUid: number;
  maxMessages: number;
}

/**
 * One synchronisation pass: select the source folder, fetch messages with
 * UID greater than the stored cursor, apply the rules in order and MOVE the
 * matches. Failures on a single message are recorded and do not abort the
 * run; the cursor only advances past messages that were handled (moved or
 * deliberately kept), so a failing message is retried on the next run.
 */
export async function runSyncPass(deps: SyncEngineDeps): Promise<SyncRunResult> {
  const { client, rules, defaultTargetFolder, sourceFolder, lastUid, maxMessages } = deps;
  const { matchRules } = await import("./rules.js");

  await client.connect();
  try {
    await client.selectMailbox(sourceFolder);
    const highestUid = await client.getHighestUid();
    const result: SyncRunResult = {
      fetched: 0,
      moved: 0,
      skipped: 0,
      errors: 0,
      highestUidSeen: null,
      details: [],
    };
    if (highestUid <= lastUid) {
      return result;
    }
    const messages = await client.listMessages(lastUid, highestUid, maxMessages);
    result.fetched = messages.length;
    let cursor = lastUid;
    for (const message of messages) {
      const match = matchRules(rules, message, defaultTargetFolder);
      if (!match.targetFolder) {
        result.skipped += 1;
        result.details.push({
          uid: message.uid,
          from: message.from,
          subject: message.subject,
          messageId: message.messageId,
          targetFolder: null,
          ruleName: null,
          status: "kept",
        });
        cursor = message.uid;
        continue;
      }
      try {
        await client.moveMessage(message.uid, match.targetFolder);
        result.moved += 1;
        result.details.push({
          uid: message.uid,
          from: message.from,
          subject: message.subject,
          messageId: message.messageId,
          targetFolder: match.targetFolder,
          ruleName: match.ruleName,
          status: "moved",
        });
        cursor = message.uid;
      } catch (error) {
        result.errors += 1;
        result.details.push({
          uid: message.uid,
          from: message.from,
          subject: message.subject,
          messageId: message.messageId,
          targetFolder: match.targetFolder,
          ruleName: match.ruleName,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        // Do not advance the cursor past a failed message: retry next run.
        break;
      }
    }
    result.highestUidSeen = cursor > lastUid ? cursor : null;
    return result;
  } finally {
    await client.close().catch(() => undefined);
  }
}
