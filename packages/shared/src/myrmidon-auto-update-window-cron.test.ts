import { describe, expect, it } from "vitest";
import {
  calculateNextMaintenanceWindows,
  describeMaintenanceWindowCron,
  isValidTimezone,
  maintenanceWindowCronExpressionSchema,
  maintenanceWindowScheduleSchema,
  parseCronExpression,
  validateMaintenanceWindowCronRequestSchema,
  validateMaintenanceWindowCronSchedule,
} from "./myrmidon-auto-update-window-cron.js";

describe("myrmidon-auto-update-window-cron", () => {
  describe("parseCronExpression", () => {
    it("parses a standard weekly cron expression", () => {
      const res = parseCronExpression("0 3 * * 0");
      expect(res.error).toBeUndefined();
      expect(res.schedule).toEqual({
        minutes: [0],
        hours: [3],
        daysOfMonth: Array.from({ length: 31 }, (_, i) => i + 1),
        months: Array.from({ length: 12 }, (_, i) => i + 1),
        daysOfWeek: [0],
      });
    });

    it("supports dayOfWeek 7 as Sunday (0)", () => {
      const res = parseCronExpression("30 2 * * 7");
      expect(res.error).toBeUndefined();
      expect(res.schedule?.daysOfWeek).toEqual([0]);
    });

    it("supports ranges, steps, and lists", () => {
      const res = parseCronExpression("*/15 2-4 * * 1,3,5");
      expect(res.error).toBeUndefined();
      expect(res.schedule?.minutes).toEqual([0, 15, 30, 45]);
      expect(res.schedule?.hours).toEqual([2, 3, 4]);
      expect(res.schedule?.daysOfWeek).toEqual([1, 3, 5]);
    });

    it("supports month and weekday names", () => {
      const res = parseCronExpression("0 4 15 JAN,MAR SUN");
      expect(res.error).toBeUndefined();
      expect(res.schedule?.months).toEqual([1, 3]);
      expect(res.schedule?.daysOfWeek).toEqual([0]);
    });

    it("rejects empty or whitespace expressions", () => {
      const res1 = parseCronExpression("");
      expect(res1.schedule).toBeUndefined();
      expect(res1.field).toBe("format");

      const res2 = parseCronExpression("   ");
      expect(res2.schedule).toBeUndefined();
    });

    it("rejects expressions without exactly 5 fields", () => {
      const res4 = parseCronExpression("0 3 * *");
      expect(res4.schedule).toBeUndefined();
      expect(res4.error).toContain("must have exactly 5 fields");

      const res6 = parseCronExpression("0 3 * * * *");
      expect(res6.schedule).toBeUndefined();
      expect(res6.error).toContain("must have exactly 5 fields");
    });

    it("rejects minute out of bounds", () => {
      const res = parseCronExpression("60 3 * * *");
      expect(res.schedule).toBeUndefined();
      expect(res.field).toBe("minute");
      expect(res.error).toContain("out of allowed bounds");
    });

    it("rejects hour out of bounds", () => {
      const res = parseCronExpression("0 24 * * *");
      expect(res.schedule).toBeUndefined();
      expect(res.field).toBe("hour");
      expect(res.error).toContain("out of allowed bounds");
    });

    it("rejects dayOfMonth out of bounds", () => {
      const res1 = parseCronExpression("0 3 0 * *");
      expect(res1.schedule).toBeUndefined();
      expect(res1.field).toBe("dayOfMonth");

      const res2 = parseCronExpression("0 3 32 * *");
      expect(res2.schedule).toBeUndefined();
      expect(res2.field).toBe("dayOfMonth");
    });

    it("rejects month out of bounds", () => {
      const res = parseCronExpression("0 3 * 13 *");
      expect(res.schedule).toBeUndefined();
      expect(res.field).toBe("month");
    });

    it("rejects dayOfWeek out of bounds", () => {
      const res = parseCronExpression("0 3 * * 8");
      expect(res.schedule).toBeUndefined();
      expect(res.field).toBe("dayOfWeek");
    });

    it("rejects inverted range", () => {
      const res = parseCronExpression("0 5-2 * * *");
      expect(res.schedule).toBeUndefined();
      expect(res.field).toBe("hour");
      expect(res.error).toContain("cannot be greater than");
    });

    it("rejects zero or negative step", () => {
      const res = parseCronExpression("*/0 * * * *");
      expect(res.schedule).toBeUndefined();
      expect(res.field).toBe("minute");
      expect(res.error).toContain("greater than 0");
    });
  });

  describe("isValidTimezone", () => {
    it("returns true for valid timezones", () => {
      expect(isValidTimezone("UTC")).toBe(true);
      expect(isValidTimezone("America/New_York")).toBe(true);
      expect(isValidTimezone("Europe/Berlin")).toBe(true);
    });

    it("returns false for invalid timezones", () => {
      expect(isValidTimezone("Invalid/Timezone")).toBe(false);
      expect(isValidTimezone("")).toBe(false);
    });
  });

  describe("describeMaintenanceWindowCron", () => {
    it("describes weekly Sunday schedule", () => {
      const desc = describeMaintenanceWindowCron("0 3 * * 0", 120, "UTC");
      expect(desc).toBe("Every Sunday at 03:00 UTC (duration: 2h)");
    });

    it("describes weekday schedule", () => {
      const desc = describeMaintenanceWindowCron("0 2 * * 1-5", 60, "UTC");
      expect(desc).toBe("Monday through Friday at 02:00 UTC (duration: 1h)");
    });

    it("describes daily schedule", () => {
      const desc = describeMaintenanceWindowCron("30 4 * * *", 90, "UTC");
      expect(desc).toBe("Every day at 04:30 UTC (duration: 90m)");
    });
  });

  describe("calculateNextMaintenanceWindows", () => {
    it("calculates future windows strictly after reference date", () => {
      const ref = new Date("2026-10-31T00:00:00.000Z"); // Saturday
      const windows = calculateNextMaintenanceWindows("0 3 * * 0", 2, 120, ref);

      expect(windows).toHaveLength(2);
      expect(windows[0]?.startsAt).toBe("2026-11-01T03:00:00.000Z"); // First Sunday
      expect(windows[0]?.endsAt).toBe("2026-11-01T05:00:00.000Z");
      expect(windows[0]?.durationMinutes).toBe(120);

      expect(windows[1]?.startsAt).toBe("2026-11-08T03:00:00.000Z"); // Second Sunday
      expect(windows[1]?.endsAt).toBe("2026-11-08T05:00:00.000Z");
    });
  });

  describe("validateMaintenanceWindowCronSchedule", () => {
    it("validates successful schedule and calculates next runs", () => {
      const res = validateMaintenanceWindowCronSchedule(
        {
          cron: "0 3 * * 0",
          durationMinutes: 120,
          timezone: "UTC",
        },
        { referenceDate: new Date("2026-10-31T00:00:00.000Z") },
      );

      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.cron).toBe("0 3 * * 0");
        expect(res.durationMinutes).toBe(120);
        expect(res.timezone).toBe("UTC");
        expect(res.description).toBe("Every Sunday at 03:00 UTC (duration: 2h)");
        expect(res.nextRuns).toHaveLength(3);
        expect(res.nextRuns[0]?.startsAt).toBe("2026-11-01T03:00:00.000Z");
      }
    });

    it("returns error for invalid duration (< 5 min or > 1440 min)", () => {
      const low = validateMaintenanceWindowCronSchedule({
        cron: "0 3 * * 0",
        durationMinutes: 4,
      });
      expect(low.valid).toBe(false);
      if (!low.valid) {
        expect(low.field).toBe("durationMinutes");
        expect(low.error).toContain("at least 5 minutes");
      }

      const high = validateMaintenanceWindowCronSchedule({
        cron: "0 3 * * 0",
        durationMinutes: 1500,
      });
      expect(high.valid).toBe(false);
      if (!high.valid) {
        expect(high.field).toBe("durationMinutes");
        expect(high.error).toContain("must not exceed 1440 minutes");
      }
    });

    it("returns error for invalid timezone", () => {
      const res = validateMaintenanceWindowCronSchedule({
        cron: "0 3 * * 0",
        timezone: "Atlantis/Poseidon",
      });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.field).toBe("timezone");
        expect(res.error).toContain("Invalid timezone");
      }
    });
  });

  describe("Zod schemas", () => {
    it("validates valid cron via maintenanceWindowCronExpressionSchema", () => {
      expect(maintenanceWindowCronExpressionSchema.safeParse("0 3 * * 0").success).toBe(true);
      expect(maintenanceWindowCronExpressionSchema.safeParse("invalid cron").success).toBe(false);
    });

    it("validates full schedule via maintenanceWindowScheduleSchema", () => {
      const valid = maintenanceWindowScheduleSchema.safeParse({
        cron: "0 4 * * 1-5",
        durationMinutes: 60,
        timezone: "UTC",
        enabled: true,
      });
      expect(valid.success).toBe(true);

      const invalidDuration = maintenanceWindowScheduleSchema.safeParse({
        cron: "0 4 * * 1-5",
        durationMinutes: 2,
      });
      expect(invalidDuration.success).toBe(false);
    });

    it("validates API request via validateMaintenanceWindowCronRequestSchema", () => {
      const valid = validateMaintenanceWindowCronRequestSchema.safeParse({
        cron: "0 3 * * 0",
        durationMinutes: 120,
      });
      expect(valid.success).toBe(true);

      const empty = validateMaintenanceWindowCronRequestSchema.safeParse({});
      expect(empty.success).toBe(false);
    });
  });
});
