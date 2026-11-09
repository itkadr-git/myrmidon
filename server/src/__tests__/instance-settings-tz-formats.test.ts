import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  patchInstanceGeneralSettingsSchema,
  DEFAULT_INSTANCE_TIME_ZONE,
  DEFAULT_INSTANCE_NUMBER_FORMAT,
  DEFAULT_INSTANCE_DATE_FORMAT,
} from "@myrmidon/shared";
import { instanceSettingsService } from "../services/instance-settings.js";

function stubRows<T>(values: T[]) {
  const p = Promise.resolve(values) as Promise<T[]> & {
    limit(_n?: number): Promise<T[]>;
    for(_mode?: string): Promise<T[]>;
  };
  p.limit = () => p;
  p.for = () => p;
  return p;
}

function stubDb(general: Record<string, unknown>) {
  let row: Record<string, unknown> = {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
  const db = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => stubRows([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        row = { ...row, ...values };
        return { where: () => ({ returning: () => Promise.resolve([row]) }) };
      },
    }),
  } as unknown as Db;
  return db;
}

describe("instance settings: general timeZone, numberFormat, dateFormat (OPE-10132)", () => {
  it("returns default values when DB row has no timezone or formats set (old installations)", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const general = await svc.getGeneral();

    expect(general.timeZone).toBe(DEFAULT_INSTANCE_TIME_ZONE); // "Asia/Irkutsk"
    expect(general.numberFormat).toBe(DEFAULT_INSTANCE_NUMBER_FORMAT); // "en-US"
    expect(general.dateFormat).toBe(DEFAULT_INSTANCE_DATE_FORMAT); // "ymd"
  });

  it("PATCH with timeZone: Europe/Moscow is saved and read back", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const updated = await svc.updateGeneral({ timeZone: "Europe/Moscow" });

    expect(updated.general.timeZone).toBe("Europe/Moscow");

    const read = await svc.getGeneral();
    expect(read.timeZone).toBe("Europe/Moscow");
    // defaults for unchanged format fields
    expect(read.numberFormat).toBe("en-US");
    expect(read.dateFormat).toBe("ymd");
  });

  it("PATCH with numberFormat and dateFormat is saved and read back", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const updated = await svc.updateGeneral({
      numberFormat: "ru-RU",
      dateFormat: "dmy",
    });

    expect(updated.general.numberFormat).toBe("ru-RU");
    expect(updated.general.dateFormat).toBe("dmy");

    const read = await svc.getGeneral();
    expect(read.numberFormat).toBe("ru-RU");
    expect(read.dateFormat).toBe("dmy");
  });

  it("PATCH leaves all other general fields and nested blocks unchanged", async () => {
    const initialGeneral = {
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      processes: { mode: "split", apiCount: 2, leaderLeaseTtlSec: 45 },
      taskDrain: { draining: true, startedAt: "2026-10-31T00:00:00.000Z", expiresAt: null },
    };
    const svc = instanceSettingsService(stubDb(initialGeneral), { runtimeEnv: {} });

    await svc.updateGeneral({ timeZone: "Europe/Moscow" });

    const read = await svc.getGeneral();
    expect(read.timeZone).toBe("Europe/Moscow");
    expect(read.censorUsernameInLogs).toBe(true);
    expect(read.keyboardShortcuts).toBe(true);
    expect(read.processes).toEqual(initialGeneral.processes);
    expect(read.taskDrain).toEqual(initialGeneral.taskDrain);
  });

  it("validates timeZone on PATCH path: valid zones pass, unknown/invalid like Mars/Base fail", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "Europe/Moscow" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "Asia/Irkutsk" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "UTC" }).success).toBe(true);

    // Invalid time zones
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "Mars/Base" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "Invalid/Zone" }).success).toBe(false);
  });

  it("validates numberFormat on PATCH path: en-US and ru-RU pass, others fail", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ numberFormat: "en-US" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ numberFormat: "ru-RU" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ numberFormat: "de-DE" }).success).toBe(false);
  });

  it("validates dateFormat on PATCH path: ymd, dmy, mdy pass, others fail", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ dateFormat: "ymd" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ dateFormat: "dmy" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ dateFormat: "mdy" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ dateFormat: "ydm" }).success).toBe(false);
  });
});
