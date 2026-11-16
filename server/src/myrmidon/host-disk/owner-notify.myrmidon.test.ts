import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createOwnerTelegramNotifier } from "./owner-notify.js";
import { resolveTargetConversation } from "../telegram-notify/jobs.js";

const ownerDm = vi.hoisted(() => ({ find: vi.fn() }));
const updates = vi.hoisted(() => ({ value: { enabled: true, chatId: "owner-chat" as string | null, topicId: null as string | null } }));

vi.mock("../bot-containers/update-notify.js", () => ({
  findActiveOwnerDeliveryConversation: ownerDm.find,
}));

vi.mock("../telegram-notify/settings-store.js", () => ({
  readTelegramNotifySettingsDocument: vi.fn(async () => ({ settings: { updates: updates.value } })),
}));

vi.mock("../telegram-notify/jobs.js", () => ({
  resolveTargetConversation: vi.fn(async () => ({
    endpointId: "endpoint-1", conversationId: "conversation-1", issueId: "issue-1", threadId: "thread-1",
  })),
}));

const at = "2026-11-16T01:00:00.000Z";
const input = {
  usage: { mount: "/bots", totalBytes: 1000, usedBytes: 901, freeBytes: 99, usedPercent: 90.1, at },
  settings: { partitionThresholdPercent: 85, partitionCriticalPercent: 95, partitionRefuseOpenPercent: 90 },
  level: "critical" as const,
};
function fakeDb() {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn((_value: unknown) => ({ onConflictDoNothing }));
  return { values, db: { insert: vi.fn(() => ({ values })) } as unknown as Db };
}

describe("bot partition owner recipient", () => {
  beforeEach(() => {
    ownerDm.find.mockReset();
    vi.mocked(resolveTargetConversation).mockClear();
    updates.value = { enabled: false, chatId: null, topicId: null };
  });

  it("uses the owner's direct conversation even when no updates channel is configured (production shape)", async () => {
    ownerDm.find.mockResolvedValue({ endpointId: "e-dm", conversationId: "c-dm", issueId: "i-dm" });
    const { db, values } = fakeDb();
    await createOwnerTelegramNotifier(db, { listCompanyIds: async () => ["company-1"] })(input);
    expect(values.mock.calls[0][0]).toMatchObject({ endpointId: "e-dm", conversationId: "c-dm", state: "pending" });
    expect(resolveTargetConversation).not.toHaveBeenCalled();
  });

  it("falls back to the configured updates channel, and sends nothing when neither exists", async () => {
    ownerDm.find.mockResolvedValue(null);
    updates.value = { enabled: true, chatId: "owner-chat", topicId: null };
    const first = fakeDb();
    await createOwnerTelegramNotifier(first.db, { listCompanyIds: async () => ["company-1"] })(input);
    expect(first.values.mock.calls[0][0]).toMatchObject({ endpointId: "endpoint-1" });
    updates.value = { enabled: false, chatId: null, topicId: null };
    const second = fakeDb();
    await createOwnerTelegramNotifier(second.db, { listCompanyIds: async () => ["company-1"] })(input);
    expect(second.values).not.toHaveBeenCalled();
  });
});

describe("bot partition owner outbox", () => {
  beforeEach(() => {
    ownerDm.find.mockReset();
    ownerDm.find.mockResolvedValue(null);
    updates.value = { enabled: true, chatId: "owner-chat", topicId: null };
  });

  it("enqueues a pending owner publication with the measured free-space warning", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn((_value: unknown) => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Db;
    const notify = createOwnerTelegramNotifier(db, { listCompanyIds: async () => ["company-1"] });
    await notify({
      usage: { mount: "/bots", totalBytes: 1000, usedBytes: 901, freeBytes: 99, usedPercent: 90.1, at },
      settings: { partitionThresholdPercent: 85, partitionCriticalPercent: 95, partitionRefuseOpenPercent: 90 },
      level: "critical",
    });
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toMatchObject({
      companyId: "company-1", endpointId: "endpoint-1", conversationId: "conversation-1",
      issueId: "issue-1", state: "pending",
      idempotencyKey: `host-disk:partition-critical:company-1:/bots:${at}`,
      payload: { text: expect.stringContaining("less than 10% free space") },
    });
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });
});
