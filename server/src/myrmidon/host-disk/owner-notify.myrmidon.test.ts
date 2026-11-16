import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createOwnerTelegramNotifier } from "./owner-notify.js";

vi.mock("../telegram-notify/settings-store.js", () => ({
  readTelegramNotifySettingsDocument: vi.fn(async () => ({
    settings: { updates: { enabled: true, chatId: "owner-chat", topicId: null } },
  })),
}));

vi.mock("../telegram-notify/jobs.js", () => ({
  resolveTargetConversation: vi.fn(async () => ({
    endpointId: "endpoint-1", conversationId: "conversation-1", issueId: "issue-1", threadId: "thread-1",
  })),
}));

describe("bot partition owner outbox", () => {
  it("enqueues a pending owner publication with the measured free-space warning", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn((_value: unknown) => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Db;
    const notify = createOwnerTelegramNotifier(db, { listCompanyIds: async () => ["company-1"] });
    const at = "2026-11-16T01:00:00.000Z";
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
