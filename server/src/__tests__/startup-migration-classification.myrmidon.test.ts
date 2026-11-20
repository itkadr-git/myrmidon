import { describe, expect, it } from "vitest";
import { migrationRefusalError, shouldReportStartupFailure, StartupRefusalError } from "../startup-refusals.ts";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const supervised = deepFreeze({ PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.com" });
const unsupervised = deepFreeze({});

const cases = [
  { appliedMigrations: [], tableCount: 0, kind: "schema-not-yet-migrated", reportSupervised: false },
  { appliedMigrations: [], tableCount: 1, kind: null, reportSupervised: true },
  { appliedMigrations: [], tableCount: 41, kind: null, reportSupervised: true },
  { appliedMigrations: ["0000_init.sql"], tableCount: 0, kind: "schema-migration-pending", reportSupervised: false },
  { appliedMigrations: ["0000_init.sql"], tableCount: 1, kind: "schema-migration-pending", reportSupervised: false },
  { appliedMigrations: ["0000_init.sql"], tableCount: 41, kind: "schema-migration-pending", reportSupervised: false },
  { appliedMigrations: ["0000_init.sql", "0001_next.sql"], tableCount: 0, kind: "schema-migration-pending", reportSupervised: false },
  { appliedMigrations: ["0000_init.sql", "0001_next.sql"], tableCount: 1, kind: "schema-migration-pending", reportSupervised: false },
  { appliedMigrations: ["0000_init.sql", "0001_next.sql"], tableCount: 41, kind: "schema-migration-pending", reportSupervised: false },
] as const;

describe("migration refusal classification", () => {
  it.each(cases)("classifies journal $appliedMigrations with $tableCount tables", ({ appliedMigrations, tableCount, kind, reportSupervised }) => {
    const state = deepFreeze({ appliedMigrations: [...appliedMigrations], tableCount });
    const message = `Pending migrations: journal=${appliedMigrations.length}, tables=${tableCount}`;
    const error = migrationRefusalError(state, message);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(message);
    expect(error.name).toBe(kind === null ? "Error" : "StartupRefusalError");
    if (kind === null) {
      expect(error).not.toBeInstanceOf(StartupRefusalError);
      expect(error.constructor).toBe(Error);
    } else {
      expect(error).toBeInstanceOf(StartupRefusalError);
      expect((error as StartupRefusalError).kind).toBe(kind);
    }
    expect(shouldReportStartupFailure(error, supervised)).toBe(reportSupervised);
    expect(shouldReportStartupFailure(error, unsupervised)).toBe(true);
  });

  it("does not carry kind or message across alternating calls", () => {
    const fresh = deepFreeze({ appliedMigrations: [] as string[], tableCount: 0 });
    const pending = deepFreeze({ appliedMigrations: ["0000_init.sql"], tableCount: 1 });
    const drift = deepFreeze({ appliedMigrations: [] as string[], tableCount: 41 });
    const first = migrationRefusalError(fresh, "fresh first");
    const second = migrationRefusalError(pending, "pending second");
    const third = migrationRefusalError(drift, "drift third");
    const fourth = migrationRefusalError(fresh, "fresh fourth");

    expect(first).toBeInstanceOf(StartupRefusalError);
    expect((first as StartupRefusalError).kind).toBe("schema-not-yet-migrated");
    expect(first.message).toBe("fresh first");
    expect(second).toBeInstanceOf(StartupRefusalError);
    expect((second as StartupRefusalError).kind).toBe("schema-migration-pending");
    expect(second.message).toBe("pending second");
    expect(third).not.toBeInstanceOf(StartupRefusalError);
    expect(third.name).toBe("Error");
    expect(third.message).toBe("drift third");
    expect(fourth).toBeInstanceOf(StartupRefusalError);
    expect((fourth as StartupRefusalError).kind).toBe("schema-not-yet-migrated");
    expect(fourth.message).toBe("fresh fourth");
    expect(first).not.toBe(fourth);
  });
});
