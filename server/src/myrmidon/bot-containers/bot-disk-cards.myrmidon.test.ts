// myrmidon(1.6.5 BOT-DISK-H4c): attention cards of the bot-disk lifecycle —
// boundaries of every condition of design section 5, stable dedup keys, cards
// vanishing with their condition, contract conformance, no secrets in wording.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WS_CARD_KEYS,
  wsDiskReportSchema,
  type WsDiskReport,
} from "@paperclipai/shared";
import {
  BOT_DISK_ARCHIVE_TTL_MS,
  buildAgentSilentCards,
  buildArchiveCards,
  buildBotDiskCards,
  buildDriftCards,
  buildForeignCards,
  buildImageStaleCards,
  readBotDiskReports,
  redactReportText,
  registerBotDiskReportsReader,
  type BotDiskBotSnapshot,
  type BotDiskCardsInput,
} from "./bot-disk-cards.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-06T15:00:00Z");

function fixture(): WsDiskReport {
  const file = path.resolve(__dirname, "../../../../docs/myrmidon/bot-disk-contract/disk-report.json");
  return wsDiskReportSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

function bot(over: Partial<BotDiskBotSnapshot> = {}): BotDiskBotSnapshot {
  return {
    botKey: "bot-001",
    running: true,
    receivedAtMs: NOW - 5 * MIN,
    report: { ...fixture(), copies: [], archives: [], foreign: [] },
    ...over,
  };
}

function input(bots: BotDiskBotSnapshot[], extra: Partial<BotDiskCardsInput> = {}): BotDiskCardsInput {
  return { nowMs: NOW, bots, ...extra };
}

describe("contract", () => {
  it("the contract fixture passes the report schema and yields only contract card keys", () => {
    const report = fixture();
    const cards = buildBotDiskCards(
      input([bot({ report })], { currentImage: { generation: "myr-v1.6.5-rc.6", sinceMs: NOW - 48 * HOUR } }),
    );
    expect(cards.length).toBeGreaterThan(0);
    const keys = new Set<string>(Object.values(WS_CARD_KEYS));
    for (const card of cards) {
      expect(keys.has(card.cardKey)).toBe(true);
      expect(card.dedupKey.startsWith(card.cardKey)).toBe(true);
      expect(card.payload.botKey).toBe("bot-001");
      expect(typeof card.payload.at).toBe("string");
    }
  });
});

describe("agent-silent", () => {
  const at = (ageMin: number) => input([bot({ receivedAtMs: NOW - ageMin * MIN })]);
  it("no card at 29 min, a card at 31 min", () => {
    expect(buildAgentSilentCards(at(29))).toHaveLength(0);
    expect(buildAgentSilentCards(at(30))).toHaveLength(0);
    const cards = buildAgentSilentCards(at(31));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.dedupKey).toBe("bot_disk_lifecycle/agent-silent:bot-001");
    expect(cards[0]!.sourceKind).toBe("bot_disk_lifecycle");
  });
  it("a stopped container never raises it; a running one that never reported does not either", () => {
    expect(buildAgentSilentCards(input([bot({ running: false, receivedAtMs: NOW - 5 * HOUR })]))).toHaveLength(0);
    expect(buildAgentSilentCards(input([bot({ receivedAtMs: null, report: null })]))).toHaveLength(0);
  });
  it("70 running bots with no reports at all raise 0 cards", () => {
    const bots = Array.from({ length: 70 }, (_, i) =>
      bot({ botKey: `bot-${String(i + 1).padStart(3, "0")}`, receivedAtMs: null, report: null }),
    );
    expect(buildAgentSilentCards(input(bots))).toHaveLength(0);
  });
  it("a bot that reported before and went silent carries lastReportAt", () => {
    const cards = buildAgentSilentCards(input([bot({ receivedAtMs: NOW - 5 * HOUR })]));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.payload.lastReportAt).toBe(new Date(NOW - 5 * HOUR).toISOString());
  });
  it("one card per bot; the dedup key is stable across ticks and goes when a report arrives", () => {
    const a = buildAgentSilentCards(input([bot({ receivedAtMs: NOW - 40 * MIN })]));
    const b = buildAgentSilentCards({ ...input([bot({ receivedAtMs: NOW - 40 * MIN })]), nowMs: NOW + 7 * MIN });
    expect(a[0]!.dedupKey).toBe(b[0]!.dedupKey);
    expect(buildAgentSilentCards(input([bot({ receivedAtMs: NOW - MIN })]))).toHaveLength(0);
  });
});

describe("drift", () => {
  const withClosing = (sinceMinAgo: number, copy: Record<string, unknown> = {}) => {
    const report = fixture();
    report.copies = [{ ...report.copies[0]!, ...copy }];
    return input(
      [bot({ report, closingSince: { "ABC-101": new Date(NOW - sinceMinAgo * MIN).toISOString() } })],
      { graceClosingMinutes: 30 },
    );
  };
  it("no card at grace+14, a card at grace+16 (grace 30)", () => {
    expect(buildDriftCards(withClosing(44))).toHaveLength(0);
    expect(buildDriftCards(withClosing(45))).toHaveLength(0);
    const cards = buildDriftCards(withClosing(46));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.dedupKey).toBe("bot_disk_lifecycle/drift:bot-001:ABC-101");
    expect(cards[0]!.issueKey).toBe("ABC-101");
  });
  it("the boundary follows the setting, not a constant", () => {
    const i = withClosing(46);
    expect(buildDriftCards({ ...i, graceClosingMinutes: 60 })).toHaveLength(0);
  });
  it("the reason comes from the report: a skip action first, then the copy reason, then the state", () => {
    const report = fixture();
    report.copies = [{ ...report.copies[0]!, clean: false, reason: "copy reason" }];
    report.actions = [{ at: report.at, action: "skip", path: "/workspace/ABC-101", result: "skipped", detail: "unpushed work, archive full" }];
    const closing = { "ABC-101": new Date(NOW - 2 * HOUR).toISOString() };
    const a = buildDriftCards(input([bot({ report, closingSince: closing })]));
    expect(a[0]!.payload.reason).toBe("unpushed work, archive full");
    report.actions = [];
    expect(buildDriftCards(input([bot({ report, closingSince: closing })]))[0]!.payload.reason).toBe("copy reason");
    report.copies[0]!.reason = undefined;
    expect(buildDriftCards(input([bot({ report, closingSince: closing })]))[0]!.payload.reason).toMatch(/uncommitted/);
  });
  it("vanishes when the copy leaves the report or the task is active again; live tasks and scratch never drift", () => {
    const i = withClosing(120);
    expect(buildDriftCards(i)).toHaveLength(1);
    const gone = bot({ report: { ...fixture(), copies: [] }, closingSince: { "ABC-101": new Date(NOW - 120 * MIN).toISOString() } });
    expect(buildDriftCards(input([gone]))).toHaveLength(0);
    expect(buildDriftCards(input([bot({ report: i.bots[0]!.report, closingSince: {} })]))).toHaveLength(0);
    expect(buildDriftCards(withClosing(120, { class: "G" }))).toHaveLength(0);
  });
});

describe("foreign", () => {
  it("a card at once for every foreign entry and class-X copy, path and sign in the payload", () => {
    const report = fixture();
    report.foreign = [{ path: "/workspace/odd-clone", sign: "promisor" }];
    report.copies = [{ ...report.copies[0]!, path: "/workspace/x2", class: "X", key: undefined }];
    const cards = buildForeignCards(input([bot({ report })]));
    expect(cards.map((c) => c.payload.path).sort()).toEqual(["/workspace/odd-clone", "/workspace/x2"]);
    expect(cards.find((c) => c.payload.path === "/workspace/odd-clone")!.payload.sign).toBe("promisor");
    expect(cards[0]!.dedupKey).toBe("bot_disk_lifecycle/foreign:bot-001:/workspace/odd-clone");
  });
  it("a path listed twice is one card; a token sign is high severity; empty list = no card", () => {
    const report = fixture();
    report.foreign = [{ path: "/workspace/a", sign: "token" }];
    report.copies = [{ ...report.copies[0]!, path: "/workspace/a", class: "X" }];
    const cards = buildForeignCards(input([bot({ report })]));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.severity).toBe("high");
    report.foreign = [];
    report.copies = [];
    expect(buildForeignCards(input([bot({ report })]))).toHaveLength(0);
  });
});

describe("bot_disk_archive", () => {
  it("a card on the task while the archive is in the report; none after restore", () => {
    const report = fixture();
    const cards = buildArchiveCards(input([bot({ report })]));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ sourceKind: "bot_disk_archive", issueKey: "ABC-099" });
    expect(cards[0]!.dedupKey).toBe("bot_disk_archive:bot-001:ABC-099-20261006T140100Z.bundle");
    report.archives = [];
    expect(buildArchiveCards(input([bot({ report })]))).toHaveLength(0);
  });
  it("expires at 30 days: shown at 30 d minus a minute, gone at 30 d", () => {
    const report = fixture();
    const created = Date.parse(report.archives[0]!.createdAt);
    const near = { ...input([bot({ report })]), nowMs: created + BOT_DISK_ARCHIVE_TTL_MS - MIN };
    const past = { ...input([bot({ report })]), nowMs: created + BOT_DISK_ARCHIVE_TTL_MS };
    expect(buildArchiveCards(near)).toHaveLength(1);
    expect(buildArchiveCards(past)).toHaveLength(0);
  });
});

describe("bot_image_stale", () => {
  const cur = (sinceHoursAgo: number, generation = "myr-v1.6.5-rc.6") => ({ generation, sinceMs: NOW - sinceHoursAgo * HOUR });
  it("none at 23 h 59 and at 24 h, a card after 24 h", () => {
    const b = [bot()];
    expect(buildImageStaleCards(input(b, { currentImage: { generation: "myr-v1.6.5-rc.6", sinceMs: NOW - 24 * HOUR + MIN } }))).toHaveLength(0);
    expect(buildImageStaleCards(input(b, { currentImage: cur(24) }))).toHaveLength(0);
    const cards = buildImageStaleCards(input(b, { currentImage: { generation: "myr-v1.6.5-rc.6", sinceMs: NOW - 24 * HOUR - MIN } }));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ sourceKind: "bot_image_stale", dedupKey: "bot_image_stale:bot-001" });
  });
  it("a bot on the current generation, a bot without a report, or an unknown current image: no card", () => {
    expect(buildImageStaleCards(input([bot()], { currentImage: cur(72, "myr-v1.6.5-rc.5") }))).toHaveLength(0);
    expect(buildImageStaleCards(input([bot({ report: null })], { currentImage: cur(72) }))).toHaveLength(0);
    expect(buildImageStaleCards(input([bot()], { currentImage: null }))).toHaveLength(0);
    expect(buildImageStaleCards(input([bot()]))).toHaveLength(0);
  });
});

describe("wording", () => {
  it("redacts tokens, URL credentials, e-mails and blobs from report text", () => {
    const dirty = "push to https://user:pw@github.com/a/b failed, ghp_abcdefghijklmnop1234 mail me a.b@example.com " + "A".repeat(60);
    const clean = redactReportText(dirty);
    expect(clean).not.toMatch(/ghp_|user:pw|example\.com|A{40}/);
    expect(redactReportText("word ".repeat(100))).toHaveLength(200);
  });
  it("no card text carries a token, URL credentials or e-mail even when the report does", () => {
    const report = fixture();
    report.copies = [{ ...report.copies[0]!, reason: "remote https://bob:secret@git.example.com/r.git, token ghp_abcdefghijklmnop1234" }];
    report.actions = [];
    report.imageGeneration = "gen-ghp_abcdefghijklmnop1234";
    const cards = buildBotDiskCards(
      input([bot({ report, closingSince: { "ABC-101": new Date(NOW - 3 * HOUR).toISOString() } })], {
        currentImage: { generation: "myr-v1.6.5-rc.6", sinceMs: NOW - 48 * HOUR },
      }),
    );
    expect(cards.some((c) => c.cardKey === WS_CARD_KEYS.drift)).toBe(true);
    const text = JSON.stringify(cards);
    expect(text).not.toMatch(/ghp_abcdefghijklmnop|bob:secret|@example\.com/);
  });
});

describe("reader seam", () => {
  it("returns no bots until the report store registers itself", async () => {
    registerBotDiskReportsReader(null);
    expect((await readBotDiskReports("c")).bots).toEqual([]);
    registerBotDiskReportsReader(() => ({ bots: [bot()] }));
    expect((await readBotDiskReports("c")).bots).toHaveLength(1);
    registerBotDiskReportsReader(null);
  });
});
