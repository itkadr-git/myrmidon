import { describe, expect, it } from "vitest";
import { runSyncPass, type ImapClientLike } from "../src/sync-engine.js";
import type { MailMessageInfo, MailSortRule } from "../src/rules.js";

/** In-memory IMAP double: a mailbox map of folder -> messages. */
class FakeImapClient implements ImapClientLike {
  mailboxes = new Map<string, MailMessageInfo[]>();
  selected: string | null = null;
  connected = false;

  constructor(messages: MailMessageInfo[], folder = "INBOX") {
    this.mailboxes.set(folder, [...messages]);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async selectMailbox(folder: string): Promise<void> {
    if (!this.mailboxes.has(folder)) throw new Error(`no such mailbox: ${folder}`);
    this.selected = folder;
  }

  async getHighestUid(): Promise<number> {
    const list = this.mailboxes.get(this.selected ?? "") ?? [];
    return list.reduce((max, m) => Math.max(max, m.uid), 0);
  }

  async listMessages(fromUid: number, _toUid: number, limit: number): Promise<MailMessageInfo[]> {
    const list = (this.mailboxes.get(this.selected ?? "") ?? [])
      .filter((m) => m.uid > fromUid)
      .sort((a, b) => a.uid - b.uid);
    return list.slice(0, limit);
  }

  async moveMessage(uid: number, targetFolder: string): Promise<void> {
    const source = this.mailboxes.get(this.selected ?? "");
    if (!source) throw new Error("no mailbox selected");
    const idx = source.findIndex((m) => m.uid === uid);
    if (idx < 0) throw new Error(`uid ${uid} not found`);
    const [message] = source.splice(idx, 1);
    const target = this.mailboxes.get(targetFolder) ?? [];
    target.push(message);
    this.mailboxes.set(targetFolder, target);
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

function msg(uid: number, from: string, subject: string, hasAttachment = false): MailMessageInfo {
  return { uid, from, subject, hasAttachment, messageId: `<m${uid}@test>` };
}

describe("runSyncPass", () => {
  it("moves matching messages and keeps the rest", async () => {
    const client = new FakeImapClient([
      msg(1, "news@site.io", "digest"),
      msg(2, "acc@corp.io", "invoice #1"),
      msg(3, "friend@corp.io", "hello"),
    ]);
    const rules: MailSortRule[] = [
      { name: "news", fromContains: "news@", targetFolder: "Read later" },
      { name: "finance", subjectContains: "invoice", targetFolder: "Finance" },
    ];

    const result = await runSyncPass({ client, rules, sourceFolder: "INBOX", lastUid: 0, maxMessages: 50 });

    expect(result.fetched).toBe(3);
    expect(result.moved).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.highestUidSeen).toBe(3);
    expect(client.mailboxes.get("Read later")?.map((m) => m.uid)).toEqual([1]);
    expect(client.mailboxes.get("Finance")?.map((m) => m.uid)).toEqual([2]);
    expect(client.mailboxes.get("INBOX")?.map((m) => m.uid)).toEqual([3]);
    expect(client.connected).toBe(false);
  });

  it("only processes messages with UID above the cursor", async () => {
    const client = new FakeImapClient([msg(1, "a@x.io", "old"), msg(5, "b@x.io", "new")]);
    const result = await runSyncPass({
      client,
      rules: [],
      defaultTargetFolder: "All",
      sourceFolder: "INBOX",
      lastUid: 3,
      maxMessages: 50,
    });
    expect(result.fetched).toBe(1);
    expect(result.highestUidSeen).toBe(5);
  });

  it("returns null cursor when there is nothing new", async () => {
    const client = new FakeImapClient([msg(2, "a@x.io", "old")]);
    const result = await runSyncPass({
      client,
      rules: [],
      sourceFolder: "INBOX",
      lastUid: 2,
      maxMessages: 50,
    });
    expect(result.fetched).toBe(0);
    expect(result.highestUidSeen).toBeNull();
  });

  it("respects maxMessages", async () => {
    const client = new FakeImapClient([msg(1, "a@x.io", "1"), msg(2, "a@x.io", "2"), msg(3, "a@x.io", "3")]);
    const result = await runSyncPass({
      client,
      rules: [],
      defaultTargetFolder: "All",
      sourceFolder: "INBOX",
      lastUid: 0,
      maxMessages: 2,
    });
    expect(result.fetched).toBe(2);
    expect(result.highestUidSeen).toBe(2);
  });

  it("records a move failure, stops, and does not advance past the failed message", async () => {
    const client = new FakeImapClient([msg(1, "a@x.io", "ok"), msg(2, "a@x.io", "boom"), msg(3, "a@x.io", "later")]);
    const original = client.moveMessage.bind(client);
    client.moveMessage = async (uid, folder) => {
      if (uid === 2) throw new Error("IMAP MOVE failed");
      return original(uid, folder);
    };
    const result = await runSyncPass({
      client,
      rules: [],
      defaultTargetFolder: "All",
      sourceFolder: "INBOX",
      lastUid: 0,
      maxMessages: 50,
    });
    expect(result.moved).toBe(1);
    expect(result.errors).toBe(1);
    // cursor stops at the failed message so uid 2 and 3 are retried next run
    expect(result.highestUidSeen).toBe(1);
    expect(result.details.find((d) => d.uid === 2)?.status).toBe("error");
  });

  it("applies the default target folder when no rule matches", async () => {
    const client = new FakeImapClient([msg(1, "a@x.io", "misc")]);
    const result = await runSyncPass({
      client,
      rules: [{ fromContains: "never@matches", targetFolder: "Nope" }],
      defaultTargetFolder: "Misc",
      sourceFolder: "INBOX",
      lastUid: 0,
      maxMessages: 50,
    });
    expect(result.moved).toBe(1);
    expect(client.mailboxes.get("Misc")?.map((m) => m.uid)).toEqual([1]);
  });
});
