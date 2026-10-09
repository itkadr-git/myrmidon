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
import {
  DEFAULT_CONTEXT_COMPACT_MAX_BATCHES,
  DEFAULT_HEARTBEAT_RUN_CONTEXT_DAYS,
  patchDatastoreCareRetentionSchema,
} from "@paperclipai/shared";
import {
  checkBackupGate,
  resolveBackupFilePrefix,
} from "./backup-gate.js";
import {
  compactContextSnapshot,
  CONTEXT_COMPACTED_AT_KEY,
  CONTEXT_COMPACT_KEYS,
} from "./compact.js";
import { resolveRetentionSettings, writeRetentionSettings } from "./settings.js";

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
      contextCompactMaxBatches: DEFAULT_CONTEXT_COMPACT_MAX_BATCHES,
      contextCompactMaxBatchesSource: "default",
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

  // myrmidon(1.6.5-F14B): the batches-per-company-per-pass ceiling resolves
  // the same three-step way so the first live pass can be lowered on the
  // running board (PATCH /api/myrmidon/datastore-care), no rebuild.
  it("contextCompactMaxBatches: stored settings win over env, env over the default of 10", () => {
    const both = resolveRetentionSettings(
      { datastoreCare: { retention: { contextCompactMaxBatches: 2 } } },
      { MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES: "5" },
    );
    expect(both.contextCompactMaxBatches).toBe(2);
    expect(both.contextCompactMaxBatchesSource).toBe("settings");

    const envOnly = resolveRetentionSettings({}, { MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES: "5" });
    expect(envOnly.contextCompactMaxBatches).toBe(5);
    expect(envOnly.contextCompactMaxBatchesSource).toBe("env");

    const bad = resolveRetentionSettings(
      { datastoreCare: { retention: { contextCompactMaxBatches: 0 } } },
      { MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES: "1001" },
    );
    expect(bad.contextCompactMaxBatches).toBe(DEFAULT_CONTEXT_COMPACT_MAX_BATCHES);
    expect(bad.contextCompactMaxBatchesSource).toBe("default");
  });
});

describe("myrmidon(1.6.5-DBC1) backup gate", () => {
  it("fails closed on a missing or empty dir, with diagnostics filled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-empty-"));
    try {
      const empty = checkBackupGate({ backupDir: dir });
      expect(empty.fresh).toBe(false);
      expect(empty.dirReadable).toBe(true);
      expect(empty.prefix).toBe("paperclip");
      expect(empty.newestBackupAt).toBeNull();
      expect(empty.newestBackupFile).toBeNull();
      expect(empty.newestBackupSizeBytes).toBeNull();
      expect(empty.candidates).toEqual([]);

      const missing = checkBackupGate({ backupDir: path.join(dir, "nope") });
      expect(missing.fresh).toBe(false);
      expect(missing.dirReadable).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fresh <prefix>-*.sql.gz lifts the gate; a stale one does not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-"));
    try {
      const file = path.join(dir, "paperclip-2026-10-08T00-00-00.sql.gz");
      fs.writeFileSync(file, "backup");
      const passed = checkBackupGate({ backupDir: dir });
      expect(passed.fresh).toBe(true);
      expect(passed.newestBackupFile).toBe("paperclip-2026-10-08T00-00-00.sql.gz");
      expect(passed.newestBackupSizeBytes).toBe(6);
      expect(passed.newestBackupAt).not.toBeNull();
      expect(checkBackupGate({
        backupDir: dir,
        now: new Date(Date.now() + 25 * 60 * 60 * 1000),
      }).fresh).toBe(false);
      // other prefixes do not count — and the mismatch is diagnosable
      const other = checkBackupGate({ backupDir: dir, prefix: "other" });
      expect(other.fresh).toBe(false);
      expect(other.candidates).toContain("paperclip-2026-10-08T00-00-00.sql.gz");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fresh *.dump lifts the gate (host pg_dump -Fc naming)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-dump-"));
    try {
      fs.writeFileSync(path.join(dir, "paperclip-20261008-114857.dump"), "dump");
      const result = checkBackupGate({ backupDir: dir });
      expect(result.fresh).toBe(true);
      expect(result.newestBackupFile).toBe("paperclip-20261008-114857.dump");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty prefix accepts any *.sql.gz|*.dump, newest first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-anyprefix-"));
    try {
      const older = path.join(dir, "other-20261001-000000.sql.gz");
      const newer = path.join(dir, "mydump-20261008-000000.dump");
      fs.writeFileSync(older, "x");
      fs.writeFileSync(newer, "yy");
      const olderTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(older, olderTime, olderTime);
      const result = checkBackupGate({ backupDir: dir, prefix: "" });
      expect(result.fresh).toBe(true);
      expect(result.newestBackupFile).toBe("mydump-20261008-000000.dump");
      expect(result.newestBackupSizeBytes).toBe(2);
      expect(result.candidates).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stale backup with a foreign name under a set prefix blocks, name in candidates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbc1-backups-foreign-"));
    try {
      fs.writeFileSync(path.join(dir, "other-20261008-114857.sql.gz"), "backup");
      const result = checkBackupGate({ backupDir: dir, prefix: "paperclip" });
      expect(result.fresh).toBe(false);
      expect(result.candidates).toEqual(["other-20261008-114857.sql.gz"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the prefix is the MYRMIDON_DB_BACKUP_FILE_PREFIX knob: unset defaults, explicit empty means no naming contract", () => {
    expect(resolveBackupFilePrefix({})).toBe("paperclip");
    expect(resolveBackupFilePrefix({ MYRMIDON_DB_BACKUP_FILE_PREFIX: "myrmidon" })).toBe("myrmidon");
    // Review (F14B): the docs promise "empty prefix -> any accepted file";
    // the knob must therefore distinguish "not set" from "set empty".
    expect(resolveBackupFilePrefix({ MYRMIDON_DB_BACKUP_FILE_PREFIX: "" })).toBe("");
    expect(resolveBackupFilePrefix({ MYRMIDON_DB_BACKUP_FILE_PREFIX: "   " })).toBe("");
  });

  it("empty prefix: a fresh host dump of any name lifts the gate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f14b-backups-anon-"));
    try {
      const file = path.join(dir, "board.dump");
      fs.writeFileSync(file, "pg_dump -Fc bytes");
      const gate = checkBackupGate({ backupDir: dir, prefix: "" });
      expect(gate.fresh).toBe(true);
      expect(gate.prefix).toBe("");
      expect(gate.newestBackupFile).toBe("board.dump");
      expect(gate.candidates).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("myrmidon(1.6.5-F14B) writeRetentionSettings", () => {
  type FakeGeneral = Record<string, unknown>;

  function fakeSettings(initial: FakeGeneral) {
    const state = { general: structuredClone(initial) as FakeGeneral };
    return {
      state,
      service: {
        // The service interface types general as InstanceGeneralSettings; the
        // fake carries only what the writer touches.
        getGeneral: async () => state.general as never,
        updateGeneral: async (patch: Record<string, unknown>) => {
          // Same contract as the real service: per top-level general key merge.
          state.general = { ...state.general, ...patch };
          return state.general as never;
        },
        listCompanyIds: async () => [],
      },
    };
  }

  it("PATCHing one knob never wipes the other (partial field semantics)", async () => {
    const { state, service } = fakeSettings({
      datastoreCare: { retention: { heartbeatRunContextDays: 0 } },
    });
    await writeRetentionSettings(service, { contextCompactMaxBatches: 2 });
    const retention = (state.general.datastoreCare as Record<string, unknown>)
      .retention as Record<string, unknown>;
    // The disabled compaction (0) must survive a batches-only patch; the
    // review found the old writer silently re-enabling it.
    expect(retention.heartbeatRunContextDays).toBe(0);
    expect(retention.contextCompactMaxBatches).toBe(2);
  });

  it("round-trips both fields through the stored block", async () => {
    const { state, service } = fakeSettings({});
    await writeRetentionSettings(service, {
      heartbeatRunContextDays: 5,
      contextCompactMaxBatches: 12,
    });
    const retention = (state.general.datastoreCare as Record<string, unknown>)
      .retention as Record<string, unknown>;
    expect(retention).toEqual({ heartbeatRunContextDays: 5, contextCompactMaxBatches: 12 });
    const resolved = resolveRetentionSettings(state.general, {});
    expect(resolved.heartbeatRunContextDays).toBe(5);
    expect(resolved.contextCompactMaxBatches).toBe(12);
    expect(resolved.contextCompactMaxBatchesSource).toBe("settings");
  });

  it("explicit null clears only that field and falls back to env/default", async () => {
    const { state, service } = fakeSettings({
      datastoreCare: {
        retention: { heartbeatRunContextDays: 4, contextCompactMaxBatches: 6 },
      },
    });
    await writeRetentionSettings(service, { contextCompactMaxBatches: null });
    const retention = (state.general.datastoreCare as Record<string, unknown>)
      .retention as Record<string, unknown>;
    expect("contextCompactMaxBatches" in retention).toBe(false);
    expect(retention.heartbeatRunContextDays).toBe(4);
    const resolved = resolveRetentionSettings(state.general, {
      MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES: "3",
    });
    expect(resolved.contextCompactMaxBatches).toBe(3);
    expect(resolved.contextCompactMaxBatchesSource).toBe("env");
  });

  it("keeps the pass state (contextLastRun) under the block", async () => {
    const { state, service } = fakeSettings({
      datastoreCare: {
        retention: {
          heartbeatRunContextDays: 7,
          contextLastRun: { lastRunAt: "2026-10-09T00:00:00.000Z", compactedTotal: 3 },
        },
      },
    });
    await writeRetentionSettings(service, { contextCompactMaxBatches: 1 });
    const retention = (state.general.datastoreCare as Record<string, unknown>)
      .retention as Record<string, unknown>;
    expect(retention.contextLastRun).toEqual({ lastRunAt: "2026-10-09T00:00:00.000Z", compactedTotal: 3 });
    expect(retention.contextCompactMaxBatches).toBe(1);
  });

  it("the patch schema distinguishes absent from null", () => {
    expect(patchDatastoreCareRetentionSchema.parse({})).toEqual({});
    expect(patchDatastoreCareRetentionSchema.parse({ contextCompactMaxBatches: null })).toEqual({
      contextCompactMaxBatches: null,
    });
    expect(patchDatastoreCareRetentionSchema.parse({ heartbeatRunContextDays: 0 })).toEqual({
      heartbeatRunContextDays: 0,
    });
    expect(() => patchDatastoreCareRetentionSchema.parse({ contextCompactMaxBatches: 0 })).toThrow();
    expect(() => patchDatastoreCareRetentionSchema.parse({ contextCompactMaxBatches: 1001 })).toThrow();
  });
});
