// Maintenance window cron schedule validator (1.7 AUTO-UPDATE-SETTINGS, OPE-10185).
// Validates 5-field cron expressions, duration, and timezone for maintenance windows,
// provides human-readable schedule descriptions, and calculates upcoming window intervals.

import { z } from "zod";

export interface CronFieldSpec {
  name: "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";
  min: number;
  max: number;
  names?: Record<string, number>;
}

export const CRON_FIELD_SPECS: readonly CronFieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  {
    name: "month",
    min: 1,
    max: 12,
    names: {
      JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
    },
  },
  {
    name: "dayOfWeek",
    min: 0,
    max: 7, // 0 and 7 are both Sunday
    names: {
      SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
    },
  },
];

export interface ParsedCronSchedule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

export interface MaintenanceWindowOccurrence {
  startsAt: string; // ISO-8601 UTC string
  endsAt: string;   // ISO-8601 UTC string
  durationMinutes: number;
}

export interface MaintenanceWindowCronSuccess {
  valid: true;
  cron: string;
  durationMinutes: number;
  timezone: string;
  description: string;
  nextRuns: MaintenanceWindowOccurrence[];
}

export type MaintenanceWindowCronErrorField =
  | "cron"
  | "durationMinutes"
  | "timezone"
  | "format"
  | "minute"
  | "hour"
  | "dayOfMonth"
  | "month"
  | "dayOfWeek";

export interface MaintenanceWindowCronFailure {
  valid: false;
  error: string;
  field?: MaintenanceWindowCronErrorField;
}

export type MaintenanceWindowCronValidationResult =
  | MaintenanceWindowCronSuccess
  | MaintenanceWindowCronFailure;

export interface ValidateMaintenanceWindowCronOptions {
  durationMinutes?: number;
  timezone?: string;
  count?: number;
  referenceDate?: Date;
}

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function normalizeFieldValue(raw: string, spec: CronFieldSpec): number {
  const upper = raw.toUpperCase();
  if (spec.names && Object.prototype.hasOwnProperty.call(spec.names, upper)) {
    return spec.names[upper]!;
  }
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new Error(`Invalid value "${raw}" for field "${spec.name}"`);
  }
  return num;
}

function parseCronSubfield(token: string, spec: CronFieldSpec): number[] {
  const stepParts = token.split("/");
  if (stepParts.length > 2) {
    throw new Error(`Multiple step operators in token "${token}" for field "${spec.name}"`);
  }

  let step = 1;
  if (stepParts.length === 2) {
    const stepStr = stepParts[1]!.trim();
    if (!/^\d+$/.test(stepStr)) {
      throw new Error(`Step value must be a positive integer in token "${token}" for field "${spec.name}"`);
    }
    step = Number(stepStr);
    if (step <= 0) {
      throw new Error(`Step value must be greater than 0 in token "${token}" for field "${spec.name}"`);
    }
  }

  const rangePart = stepParts[0]!.trim();
  let start: number;
  let end: number;

  if (rangePart === "*") {
    start = spec.min;
    // For dayOfWeek, internal range is 0..6 (treating 7 as 0)
    end = spec.name === "dayOfWeek" ? 6 : spec.max;
  } else if (rangePart.includes("-")) {
    const [startStr, endStr, ...extra] = rangePart.split("-");
    if (extra.length > 0 || !startStr || !endStr) {
      throw new Error(`Invalid range format "${rangePart}" for field "${spec.name}"`);
    }
    start = normalizeFieldValue(startStr.trim(), spec);
    end = normalizeFieldValue(endStr.trim(), spec);

    if (start < spec.min || start > spec.max) {
      throw new Error(`${spec.name} range start (${start}) is out of allowed bounds [${spec.min}..${spec.max}]`);
    }
    if (end < spec.min || end > spec.max) {
      throw new Error(`${spec.name} range end (${end}) is out of allowed bounds [${spec.min}..${spec.max}]`);
    }
    if (start > end) {
      throw new Error(`Range start (${start}) cannot be greater than range end (${end}) in field "${spec.name}"`);
    }
  } else {
    const val = normalizeFieldValue(rangePart, spec);
    if (val < spec.min || val > spec.max) {
      throw new Error(`${spec.name} value (${val}) is out of allowed bounds [${spec.min}..${spec.max}]`);
    }
    if (stepParts.length === 2) {
      start = val;
      end = spec.name === "dayOfWeek" ? 6 : spec.max;
    } else {
      start = val;
      end = val;
    }
  }

  const values: number[] = [];
  for (let i = start; i <= end; i += step) {
    // In cron, dayOfWeek 7 is equivalent to 0 (Sunday)
    const normalized = spec.name === "dayOfWeek" && i === 7 ? 0 : i;
    values.push(normalized);
  }
  return values;
}

export function parseCronExpression(expression: string): {
  schedule?: ParsedCronSchedule;
  error?: string;
  field?: CronFieldSpec["name"] | "format";
} {
  const trimmed = expression.trim();
  if (!trimmed) {
    return { error: "Cron expression must not be empty", field: "format" };
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    return {
      error: `Cron expression must have exactly 5 fields, got ${tokens.length}: "${trimmed}"`,
      field: "format",
    };
  }

  const results: number[][] = [];

  for (let i = 0; i < 5; i++) {
    const fieldToken = tokens[i]!;
    const spec = CRON_FIELD_SPECS[i]!;

    try {
      const items = fieldToken.split(",");
      const fieldValues = new Set<number>();

      for (const item of items) {
        const trimmedItem = item.trim();
        if (!trimmedItem) {
          return {
            error: `Empty sub-expression in field "${spec.name}"`,
            field: spec.name,
          };
        }
        const parsedValues = parseCronSubfield(trimmedItem, spec);
        for (const v of parsedValues) {
          fieldValues.add(v);
        }
      }

      if (fieldValues.size === 0) {
        return {
          error: `No valid values found for field "${spec.name}"`,
          field: spec.name,
        };
      }

      results.push([...fieldValues].sort((a, b) => a - b));
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        field: spec.name,
      };
    }
  }

  return {
    schedule: {
      minutes: results[0]!,
      hours: results[1]!,
      daysOfMonth: results[2]!,
      months: results[3]!,
      daysOfWeek: results[4]!,
    },
  };
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function describeMaintenanceWindowCron(
  expression: string,
  durationMinutes = 120,
  timezone = "UTC",
): string {
  const parsed = parseCronExpression(expression);
  if (!parsed.schedule) return "Invalid cron expression";

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed.schedule;

  const durationStr =
    durationMinutes >= 60 && durationMinutes % 60 === 0
      ? `${durationMinutes / 60}h`
      : `${durationMinutes}m`;

  const timeStr =
    minutes.length === 1 && hours.length === 1
      ? `${String(hours[0]).padStart(2, "0")}:${String(minutes[0]).padStart(2, "0")} ${timezone}`
      : `${hours.join(",")}h ${minutes.join(",")}m ${timezone}`;

  let recurrence = "";

  const allDaysOfWeek = daysOfWeek.length === 7;
  const allDaysOfMonth = daysOfMonth.length === 31;
  const allMonths = months.length === 12;

  if (allDaysOfWeek && allDaysOfMonth && allMonths) {
    recurrence = "Every day";
  } else if (!allDaysOfWeek && allDaysOfMonth && allMonths) {
    // Specific days of week
    if (daysOfWeek.length === 5 && !daysOfWeek.includes(0) && !daysOfWeek.includes(6)) {
      recurrence = "Monday through Friday";
    } else if (daysOfWeek.length === 2 && daysOfWeek.includes(0) && daysOfWeek.includes(6)) {
      recurrence = "Weekends (Saturday and Sunday)";
    } else {
      recurrence = `Every ${daysOfWeek.map((d) => DAY_NAMES[d] ?? `Day ${d}`).join(", ")}`;
    }
  } else if (allDaysOfWeek && !allDaysOfMonth && allMonths) {
    recurrence = `Monthly on day ${daysOfMonth.join(", ")}`;
  } else {
    const parts: string[] = [];
    if (!allDaysOfWeek) {
      parts.push(`on ${daysOfWeek.map((d) => DAY_NAMES[d] ?? `Day ${d}`).join(", ")}`);
    }
    if (!allDaysOfMonth) {
      parts.push(`on day ${daysOfMonth.join(", ")}`);
    }
    if (!allMonths) {
      parts.push(`in ${months.map((m) => MONTH_NAMES[m] ?? `Month ${m}`).join(", ")}`);
    }
    recurrence = parts.join(" ");
  }

  return `${recurrence} at ${timeStr} (duration: ${durationStr})`;
}

export function calculateNextMaintenanceWindows(
  expression: string,
  count = 3,
  durationMinutes = 120,
  referenceDate = new Date(),
): MaintenanceWindowOccurrence[] {
  const parsed = parseCronExpression(expression);
  if (!parsed.schedule) return [];

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed.schedule;
  const occurrences: MaintenanceWindowOccurrence[] = [];

  const minSet = new Set(minutes);
  const hourSet = new Set(hours);
  const domSet = new Set(daysOfMonth);
  const monthSet = new Set(months);
  const dowSet = new Set(daysOfWeek);

  // Search forward day by day, then check candidate hours and minutes
  const cursor = new Date(referenceDate.getTime());
  cursor.setUTCSeconds(0, 0);

  const startLimitMs = cursor.getTime();
  const maxSearchDays = 730; // 2 years safety limit
  let daysSearched = 0;

  while (occurrences.length < count && daysSearched < maxSearchDays) {
    const curYear = cursor.getUTCFullYear();
    const curMonth = cursor.getUTCMonth() + 1; // 1-12
    const curDom = cursor.getUTCDate();
    const curDow = cursor.getUTCDay(); // 0-6

    const matchesMonth = monthSet.has(curMonth);
    const matchesDom = domSet.has(curDom);
    const matchesDow = dowSet.has(curDow);

    // Standard cron day matching: if both dom and dow are specified (neither is *), either match triggers
    const isDomWildcard = daysOfMonth.length === 31;
    const isDowWildcard = daysOfWeek.length === 7;

    let dayMatches = false;
    if (matchesMonth) {
      if (isDomWildcard && isDowWildcard) {
        dayMatches = true;
      } else if (!isDomWildcard && !isDowWildcard) {
        dayMatches = matchesDom || matchesDow;
      } else if (!isDomWildcard) {
        dayMatches = matchesDom;
      } else {
        dayMatches = matchesDow;
      }
    }

    if (dayMatches) {
      for (const h of hours) {
        if (!hourSet.has(h)) continue;
        for (const m of minutes) {
          if (!minSet.has(m)) continue;

          const candidate = new Date(Date.UTC(curYear, curMonth - 1, curDom, h, m, 0, 0));
          if (candidate.getTime() > startLimitMs) {
            const endsAt = new Date(candidate.getTime() + durationMinutes * 60 * 1000);
            occurrences.push({
              startsAt: candidate.toISOString(),
              endsAt: endsAt.toISOString(),
              durationMinutes,
            });
            if (occurrences.length >= count) break;
          }
        }
        if (occurrences.length >= count) break;
      }
    }

    // Advance cursor to next day at 00:00:00 UTC
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
    daysSearched++;
  }

  return occurrences;
}

export function validateMaintenanceWindowCronSchedule(
  input: unknown,
  options?: ValidateMaintenanceWindowCronOptions,
): MaintenanceWindowCronValidationResult {
  if (typeof input !== "object" || input === null) {
    return {
      valid: false,
      error: "Input must be an object with a cron property",
      field: "cron",
    };
  }

  const record = input as Record<string, unknown>;

  if (typeof record.cron !== "string" || !record.cron.trim()) {
    return {
      valid: false,
      error: "Cron expression is required and must be a non-empty string",
      field: "cron",
    };
  }

  const rawCron = record.cron.trim();
  const parsed = parseCronExpression(rawCron);
  if (!parsed.schedule) {
    return {
      valid: false,
      error: parsed.error ?? "Invalid cron expression",
      field: parsed.field ?? "cron",
    };
  }

  // Duration validation
  const rawDuration =
    record.durationMinutes !== undefined
      ? record.durationMinutes
      : options?.durationMinutes !== undefined
        ? options.durationMinutes
        : 120;

  const durationNum =
    typeof rawDuration === "number"
      ? rawDuration
      : typeof rawDuration === "string"
        ? Number(rawDuration.trim())
        : Number.NaN;

  if (!Number.isInteger(durationNum)) {
    return {
      valid: false,
      error: "Duration must be an integer representing minutes",
      field: "durationMinutes",
    };
  }

  if (durationNum < 5) {
    return {
      valid: false,
      error: "Maintenance window duration must be at least 5 minutes",
      field: "durationMinutes",
    };
  }

  if (durationNum > 1440) {
    return {
      valid: false,
      error: "Maintenance window duration must not exceed 1440 minutes (24 hours)",
      field: "durationMinutes",
    };
  }

  // Timezone validation
  const rawTimezone =
    typeof record.timezone === "string" && record.timezone.trim()
      ? record.timezone.trim()
      : options?.timezone ?? "UTC";

  if (!isValidTimezone(rawTimezone)) {
    return {
      valid: false,
      error: `Invalid timezone "${rawTimezone}"`,
      field: "timezone",
    };
  }

  const count = options?.count ?? 3;
  const referenceDate = options?.referenceDate ?? new Date();

  const description = describeMaintenanceWindowCron(rawCron, durationNum, rawTimezone);
  const nextRuns = calculateNextMaintenanceWindows(rawCron, count, durationNum, referenceDate);

  return {
    valid: true,
    cron: rawCron,
    durationMinutes: durationNum,
    timezone: rawTimezone,
    description,
    nextRuns,
  };
}

// Zod schemas for shared use
export const maintenanceWindowCronExpressionSchema = z
  .string()
  .trim()
  .min(1, "Cron expression is required")
  .superRefine((val, ctx) => {
    const res = parseCronExpression(val);
    if (!res.schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: res.error ?? "Invalid cron expression",
      });
    }
  });

export const maintenanceWindowScheduleSchema = z.object({
  cron: maintenanceWindowCronExpressionSchema,
  durationMinutes: z.number().int().min(5).max(1440).default(120),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimezone, { message: "Invalid IANA timezone" })
    .default("UTC"),
  enabled: z.boolean().default(true),
});

export const validateMaintenanceWindowCronRequestSchema = z
  .object({
    cron: z.string().trim().min(1, "Cron expression is required"),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    timezone: z.string().trim().optional(),
  })
  .strict();

export type MaintenanceWindowSchedule = z.infer<typeof maintenanceWindowScheduleSchema>;
export type ValidateMaintenanceWindowCronRequest = z.infer<
  typeof validateMaintenanceWindowCronRequestSchema
>;
