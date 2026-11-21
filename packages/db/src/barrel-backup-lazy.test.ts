import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./backup-lib.js", () => {
  loaded();
  return { diagnosePgDumpClient: vi.fn().mockResolvedValue(null) };
});

describe("database root backup graph", () => {
  it("loads the backup engine only when a backup operation is invoked", async () => {
    const db = await import("./index.js");
    expect(loaded).not.toHaveBeenCalled();
    await expect(db.diagnosePgDumpClient("pg_dump", 18)).resolves.toBeNull();
    expect(loaded).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("preserves the public backup error identity across entry points", async () => {
    const root = await import("./index.js");
    vi.doUnmock("./backup-lib.js");
    const backup = await import("./backup-lib.js");
    expect(backup.BackupVerificationError).toBe(root.BackupVerificationError);
    expect(backup.BackupClientVersionError).toBe(root.BackupClientVersionError);
  }, 30_000);
});
