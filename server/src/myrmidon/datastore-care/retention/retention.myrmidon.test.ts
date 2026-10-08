// server/src/myrmidon/datastore-care/retention/retention.myrmidon.test.ts
//
// myrmidon(1.6.5-DBC1): the pure rules of the run-context retention — the
// snapshot compaction, the settings resolution (stored settings over
// environment over the default of 7 days, 0 disables), and the backup gate.
// No database, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HEARTBEAT_RUN_CONTEXT_DAYS } from "@paperclipai/shared";
import {
  checkBackupGate,
  resolveBackupFilePrefix,
} from "./backup-gate.js";
import {
  compactContextSnapshot,
  CONTEXT_COMPACTED_AT_KEY,
  CONTEXT_COMPACT_KEYS,
} from "./compact.js";
import { resolveRetentionSettings } from "./settings.js";

describe("myrmidon(1.6.5-DBC1) compactContextSnapshot", () => {
  it("strips exactly the O1a key list and stamps _compactedAt", () => {
    const snapshot: Record<string, unknown> = {
      taskKey: "OPE-1",
      wakeReason: "assignment",
      executionContinuation: { messages: [1, 2, 3] },
      paperclipWake: { big: true },
      paperclipTaskMarkdown: "x".repeat(1000),
      paperclipTaskMarkdownCompact: "y",
      paperclipWakeComment: { z: 1 },
      paperclipSessionHandoffMarkdown: "h",
      paperclipContinuationSummary: "s",
      externalChatContinuation: { c: 1 },
    };
    const compacted = compactContextSnapshot(snapshot, "2026-10-08T00:00:00.000Z");
    expect(compacted).not.toBeNull();
    const next = compacted!.snapshot;
    for (const key of CONTEXT_COMPACT_KEYS) {
      expect(next[key], `${key} must be gone`).toBeUndefined();
      expect(compacted!.removedKeys).toContain(key);
    }
    // small keys survive — attention-feed derivations read them
    expect(next.taskKey).toBe("OPE-1");
    expect(next.wakeReason).toBe("assignment");
    expect(next[CONTEXT_COMPACTED_AT_KEY]).toBe("2026-10-08T00:00:00.000Z");
  });

  it("returns null when the snapshot holds none of the keys (idempotent)", () => {
    expect(
      compactContextSnapshot({ taskKey: "OPE-1", issueId: "i" }, "2026-10-08T00:00:00.000Z"),
    ).toBeNull();
    // a previously compacted snapshot (only the marker) stays untouched
    expect(
      compactContextSnapshot({ [CONTEXT_COMPACTED_AT_KEY]: "earlier" }, "2026-10-08T00:00:00.000Z"),
    ).toBeNull();
  });
});

describe("myrmidon(1.6.5-DBC1) resolveRetentionSettings", () => {
  it("default 7 when nothing is stored and no env is set", () => {
    const resolved = resolveRetentionSettings({}, {});
    expect(resolved).toEqual({
      heartbeatRunContextDays: DEFAULT_HEARTBEAT_RUN_CONTEXT_DAYS,
      source: "default",
    });
  });

  it("environment overrides the default", () => {
    const resolved = resolveRetentionSettings({}, {
      PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS: "14",
    });
    expect(resolved.heartbeatRunContextDays).toBe(14);
    expect(resolved.source).toBe("env");
  });

  it("stored settings win over the environment", () => {
    const general = { datastoreCare: { retention: { heartbeatRunContextDays: 3 } } };
    const resolved = resolveRetentionSettings(general, {
      PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS: "14",
    });
    expect(resolved.heartbeatRunContextDays).toBe(3);
    expect(resolved.source).toBe("settings");
  });

  it("0 disables the compaction", () => {
    const general = { datastoreCare: { retention: { heartbeatRunContextDays: 0 } } };
    expect(resolveRetentionSettings(general, {}).heartbeatRunContextDays).toBe(0);
  });

  it("a malformed stored value falls through to env, then the default", () => {
    const general = { datastoreCare: { retention: { heartbeatRunContextDays: "seven" } } };
    expect(resolveRetentionSettings(general, {}).heartbeatRunContextDays).toBe(7);
    const badEnv = resolveRetentionSettings(general, {
      PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS: "-2",
    });
    expect(badEnv.heartbeatRunContextDays).toBe(7);
    expect(badEnv.source).toBe("default");
  });
});

describe("myrmidon(1.6.5-DBC1) backup gate", () => {
  it("fails closed on a missing or empty dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-empty-"));
    try {
      expect(checkBackupGate({ backupDir: dir }).fresh).toBe(false);
      expect(checkBackupGate({ backupDir: path.join(dir, "nope") }).fresh).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fresh <prefix>-*.sql.gz lifts the gate; a stale one does not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-"));
    try {
      const file = path.join(dir, "paperclip-2026-10-08T00-00-00.sql.gz");
      fs.writeFileSync(file, "backup");
      expect(checkBackupGate({ backupDir: dir }).fresh).toBe(true);
      expect(checkBackupGate({
        backupDir: dir,
        now: new Date(Date.now() + 25 * 60 * 60 * 1000),
      }).fresh).toBe(false);
      // other prefixes do not count
      expect(checkBackupGate({ backupDir: dir, prefix: "other" }).fresh).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the prefix is the MYRMIDON_DB_BACKUP_FILE_PREFIX knob, default paperclip", () => {
    expect(resolveBackupFilePrefix({})).toBe("paperclip");
    expect(resolveBackupFilePrefix({ MYRMIDON_DB_BACKUP_FILE_PREFIX: "myrmidon" })).toBe("myrmidon");
  });
});
