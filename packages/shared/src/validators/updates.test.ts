import { describe, expect, it } from "vitest";
import {
  autoRollbackSettingsSchema,
  canarySettingsSchema,
  maintenanceWindowBoundsSchema,
  patchUpdateSettingsSchema,
  putUpdateSettingsSchema,
  updateSettingsSchema,
} from "./updates.js";

describe("updates validators (OPE-10268)", () => {
  describe("maintenanceWindowBoundsSchema", () => {
    it("accepts valid window bounds with UTC timezone", () => {
      const parsed = maintenanceWindowBoundsSchema.parse({
        enabled: true,
        days: [1, 2, 3, 4, 5],
        fromMinute: 120,
        toMinute: 240,
        timezone: "UTC",
      });

      expect(parsed.enabled).toBe(true);
      expect(parsed.days).toEqual([1, 2, 3, 4, 5]);
      expect(parsed.fromMinute).toBe(120);
      expect(parsed.toMinute).toBe(240);
      expect(parsed.timezone).toBe("UTC");
    });

    it("defaults timezone to UTC when omitted", () => {
      const parsed = maintenanceWindowBoundsSchema.parse({
        days: [0, 6],
        fromMinute: 60,
        toMinute: 180,
      });

      expect(parsed.timezone).toBe("UTC");
    });

    it("accepts valid IANA timezones", () => {
      const parsed = maintenanceWindowBoundsSchema.parse({
        days: [1],
        fromMinute: 0,
        toMinute: 60,
        timezone: "Europe/Berlin",
      });

      expect(parsed.timezone).toBe("Europe/Berlin");
    });

    it("rejects invalid timezone", () => {
      const result = maintenanceWindowBoundsSchema.safeParse({
        days: [1],
        fromMinute: 0,
        toMinute: 60,
        timezone: "Mars/Phobos",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("timezone"))).toBe(true);
      }
    });

    it("rejects fromMinute out of bounds (< 0 or > 1439)", () => {
      const under = maintenanceWindowBoundsSchema.safeParse({ fromMinute: -1 });
      const over = maintenanceWindowBoundsSchema.safeParse({ fromMinute: 1440 });

      expect(under.success).toBe(false);
      expect(over.success).toBe(false);
    });

    it("rejects toMinute out of bounds (< 0 or > 1439)", () => {
      const under = maintenanceWindowBoundsSchema.safeParse({ toMinute: -1 });
      const over = maintenanceWindowBoundsSchema.safeParse({ toMinute: 1440 });

      expect(under.success).toBe(false);
      expect(over.success).toBe(false);
    });

    it("validates durationMinutes between 5 and 1440", () => {
      const valid = maintenanceWindowBoundsSchema.safeParse({
        fromMinute: 0,
        toMinute: 60,
        durationMinutes: 60,
      });
      const tooShort = maintenanceWindowBoundsSchema.safeParse({
        durationMinutes: 4,
      });
      const tooLong = maintenanceWindowBoundsSchema.safeParse({
        durationMinutes: 1441,
      });

      expect(valid.success).toBe(true);
      expect(tooShort.success).toBe(false);
      expect(tooLong.success).toBe(false);
    });

    it("rejects equal fromMinute and toMinute when days are configured and durationMinutes is missing", () => {
      const result = maintenanceWindowBoundsSchema.safeParse({
        days: [1, 2],
        fromMinute: 120,
        toMinute: 120,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("interval"))).toBe(true);
      }
    });
  });

  describe("canarySettingsSchema", () => {
    it("accepts valid canary configuration", () => {
      const parsed = canarySettingsSchema.parse({
        enabled: true,
        sharePercent: 20,
        minBots: 1,
        maxBots: 10,
        healthSettleSec: 300,
        stepDurationMinutes: 30,
      });

      expect(parsed.enabled).toBe(true);
      expect(parsed.sharePercent).toBe(20);
      expect(parsed.minBots).toBe(1);
      expect(parsed.maxBots).toBe(10);
      expect(parsed.healthSettleSec).toBe(300);
      expect(parsed.stepDurationMinutes).toBe(30);
    });

    it("rejects sharePercent < 0 or > 100", () => {
      const under = canarySettingsSchema.safeParse({ sharePercent: -1 });
      const over = canarySettingsSchema.safeParse({ sharePercent: 101 });

      expect(under.success).toBe(false);
      expect(over.success).toBe(false);
    });

    it("rejects percentage < 0 or > 100", () => {
      const under = canarySettingsSchema.safeParse({ percentage: -0.5 });
      const over = canarySettingsSchema.safeParse({ percentage: 100.1 });

      expect(under.success).toBe(false);
      expect(over.success).toBe(false);
    });

    it("rejects maxBots < minBots", () => {
      const result = canarySettingsSchema.safeParse({
        minBots: 10,
        maxBots: 2,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("maxBots"))).toBe(true);
      }
    });

    it("rejects negative intervals", () => {
      const negativeSettle = canarySettingsSchema.safeParse({ healthSettleSec: -10 });
      const negativeStep = canarySettingsSchema.safeParse({ stepDurationMinutes: -5 });

      expect(negativeSettle.success).toBe(false);
      expect(negativeStep.success).toBe(false);
    });
  });

  describe("autoRollbackSettingsSchema", () => {
    it("accepts valid auto-rollback configuration", () => {
      const parsed = autoRollbackSettingsSchema.parse({
        enabled: true,
        failureThresholdPercent: 15,
        healthTimeoutMinutes: 10,
        healthTimeoutSec: 600,
      });

      expect(parsed.enabled).toBe(true);
      expect(parsed.failureThresholdPercent).toBe(15);
      expect(parsed.healthTimeoutMinutes).toBe(10);
      expect(parsed.healthTimeoutSec).toBe(600);
    });

    it("rejects failureThresholdPercent < 0 or > 100", () => {
      const under = autoRollbackSettingsSchema.safeParse({ failureThresholdPercent: -1 });
      const over = autoRollbackSettingsSchema.safeParse({ failureThresholdPercent: 105 });

      expect(under.success).toBe(false);
      expect(over.success).toBe(false);
    });

    it("rejects healthTimeoutMinutes < 1 or > 1440", () => {
      const zero = autoRollbackSettingsSchema.safeParse({ healthTimeoutMinutes: 0 });
      const negative = autoRollbackSettingsSchema.safeParse({ healthTimeoutMinutes: -1 });
      const tooLarge = autoRollbackSettingsSchema.safeParse({ healthTimeoutMinutes: 2000 });

      expect(zero.success).toBe(false);
      expect(negative.success).toBe(false);
      expect(tooLarge.success).toBe(false);
    });
  });

  describe("updateSettingsSchema", () => {
    it("accepts complete combined settings", () => {
      const payload = {
        mode: "auto",
        window: {
          enabled: true,
          days: [1, 2, 3],
          fromMinute: 60,
          toMinute: 180,
          timezone: "UTC",
        },
        canary: {
          enabled: true,
          sharePercent: 25,
          minBots: 2,
          maxBots: 8,
          healthSettleSec: 600,
        },
        autoRollback: {
          enabled: true,
          failureThresholdPercent: 5,
          healthTimeoutMinutes: 10,
        },
      };

      const parsed = updateSettingsSchema.parse(payload);
      expect(parsed.mode).toBe("auto");
      expect(parsed.window?.timezone).toBe("UTC");
      expect(parsed.canary?.sharePercent).toBe(25);
      expect(parsed.autoRollback?.failureThresholdPercent).toBe(5);
    });

    it("supports partial patch schema", () => {
      const patch = patchUpdateSettingsSchema.parse({
        mode: "auto_release",
        canary: {
          sharePercent: 50,
        },
      });

      expect(patch.mode).toBe("auto_release");
      expect(patch.canary?.sharePercent).toBe(50);
    });

    describe("maintenanceWindow cron validation (OPE-12087)", () => {
      it("accepts a valid 5-field cron in window.cron", () => {
        const parsed = updateSettingsSchema.parse({
          window: {
            cron: "30 3 * * 0",
            durationMinutes: 120,
          },
        });

        expect(parsed.window?.cron).toBe("30 3 * * 0");
      });

      it("accepts cron with names, ranges, steps, and lists", () => {
        const parsed = updateSettingsSchema.parse({
          window: {
            cron: "0 2 1-7/2 JAN,JUL MON,FRI",
          },
        });

        expect(parsed.window?.cron).toBe("0 2 1-7/2 JAN,JUL MON,FRI");
      });

      it("accepts a valid flat cron alias", () => {
        const parsed = putUpdateSettingsSchema.parse({
          cron: "15 4 * * 1-5",
        });

        expect(parsed.cron).toBe("15 4 * * 1-5");
      });

      it("accepts valid maintenanceWindow cron alias (string or object)", () => {
        const parsedStr = updateSettingsSchema.parse({
          maintenanceWindow: "30 3 * * 0",
        });
        expect(parsedStr.maintenanceWindow).toBe("30 3 * * 0");

        const parsedObj = updateSettingsSchema.parse({
          maintenanceWindow: {
            cron: "30 3 * * 0",
            durationMinutes: 120,
          },
        });
        expect((parsedObj.maintenanceWindow as any)?.cron).toBe("30 3 * * 0");
      });

      it("rejects invalid maintenanceWindow cron", () => {
        for (const bad of ["invalid-cron", "60 3 * * 0", "0 3 * * 0 extra"]) {
          const resStr = updateSettingsSchema.safeParse({
            maintenanceWindow: bad,
          });
          expect(resStr.success).toBe(false);

          const resObj = updateSettingsSchema.safeParse({
            maintenanceWindow: { cron: bad },
          });
          expect(resObj.success).toBe(false);
        }
      });

      it("rejects a cron with wrong field count", () => {
        for (const bad of ["0 3 * * 0 extra", "0 3 * *", ""]) {
          const windowResult = updateSettingsSchema.safeParse({
            window: { cron: bad },
          });
          expect(windowResult.success).toBe(false);
          if (!windowResult.success) {
            expect(
              windowResult.error.issues.some((i) => i.path.join(".") === "window.cron"),
            ).toBe(true);
          }
        }
      });

      it("rejects a flat cron with wrong field count", () => {
        const result = putUpdateSettingsSchema.safeParse({ cron: "0 3 * * 0 extra" });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((i) => i.path[0] === "cron")).toBe(true);
        }
      });

      it("rejects cron fields out of bounds", () => {
        const cases = [
          "60 3 * * 0", // minute out of bounds
          "0 24 * * 0", // hour out of bounds
          "0 3 32 * 0", // day-of-month out of bounds
          "0 3 * 13 0", // month out of bounds
          "0 3 * * 8", // day-of-week out of bounds
        ];

        for (const bad of cases) {
          const result = updateSettingsSchema.safeParse({
            window: { cron: bad },
          });
          expect(result.success).toBe(false);
        }
      });

      it("rejects a cron that is not a string", () => {
        const result = updateSettingsSchema.safeParse({
          window: { cron: 42 },
        });

        expect(result.success).toBe(false);
      });
    });
  });
});
