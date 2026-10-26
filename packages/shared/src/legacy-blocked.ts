export const LEGACY_BLOCKED_IMPORT_RULE_VERSION = "1";

export const legacyBlockedClassSchema = {
  safeParse(val: unknown) {
    const classes = ["dependency", "recovery", "human_decision", "external_wait", "resource", "terminal", "unknown"] as const;
    if (typeof val === "string" && (classes as readonly string[]).includes(val)) {
      return { success: true, data: val as (typeof classes)[number] };
    }
    return { success: false, error: new Error(`Invalid legacy blocked class: ${val}`) };
  },
};

export type LegacyBlockedClass =
  | "dependency"
  | "recovery"
  | "human_decision"
  | "external_wait"
  | "resource"
  | "terminal"
  | "unknown";

export type LegacyBlockedReportRow = {
  issueId: string;
  identifier: string;
  oldStatus: string;
  oldBlockers: string[];
  class: LegacyBlockedClass;
  proposedOwner?: string;
  proposedSlaMinutes?: number;
  evidence: string;
  importKey: string;
};

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const legacyBlockedReportRowSchema = {
  safeParse(val: unknown) {
    if (!val || typeof val !== "object") {
      return { success: false, error: new Error("Row must be an object") };
    }
    const r = val as Record<string, unknown>;
    if (typeof r.issueId !== "string" || !uuidRegex.test(r.issueId)) {
      return { success: false, error: new Error("Invalid issueId uuid") };
    }
    if (typeof r.identifier !== "string" || r.identifier.trim().length === 0) {
      return { success: false, error: new Error("Invalid identifier") };
    }
    if (typeof r.oldStatus !== "string" || r.oldStatus.trim().length === 0) {
      return { success: false, error: new Error("Invalid oldStatus") };
    }
    if (!Array.isArray(r.oldBlockers) || !r.oldBlockers.every((b) => typeof b === "string")) {
      return { success: false, error: new Error("Invalid oldBlockers") };
    }
    const classCheck = legacyBlockedClassSchema.safeParse(r.class);
    if (!classCheck.success) {
      return { success: false, error: classCheck.error };
    }
    const blockClass = classCheck.data;
    if (blockClass === "unknown") {
      if (r.proposedOwner !== undefined && (typeof r.proposedOwner !== "string" || r.proposedOwner.trim().length === 0)) {
        return { success: false, error: new Error("Invalid proposedOwner") };
      }
    } else {
      if (typeof r.proposedOwner !== "string" || r.proposedOwner.trim().length === 0) {
        return { success: false, error: new Error("Missing proposedOwner") };
      }
    }
    if (r.proposedSlaMinutes !== undefined && (typeof r.proposedSlaMinutes !== "number" || !Number.isInteger(r.proposedSlaMinutes) || r.proposedSlaMinutes <= 0)) {
      return { success: false, error: new Error("Invalid proposedSlaMinutes") };
    }
    if (typeof r.evidence !== "string" || r.evidence.trim().length === 0 || r.evidence.length > 2000) {
      return { success: false, error: new Error("Invalid evidence") };
    }
    if (typeof r.importKey !== "string" || r.importKey.trim().length === 0) {
      return { success: false, error: new Error("Invalid importKey") };
    }
    const rowData: LegacyBlockedReportRow = {
      issueId: r.issueId,
      identifier: (r.identifier as string).trim(),
      oldStatus: (r.oldStatus as string).trim(),
      oldBlockers: r.oldBlockers as string[],
      class: blockClass,
      evidence: (r.evidence as string).trim(),
      importKey: (r.importKey as string).trim(),
    };
    if (typeof r.proposedOwner === "string" && r.proposedOwner.trim().length > 0) {
      rowData.proposedOwner = r.proposedOwner.trim();
    }
    if (typeof r.proposedSlaMinutes === "number") {
      rowData.proposedSlaMinutes = r.proposedSlaMinutes;
    }
    return {
      success: true,
      data: rowData,
    };
  },
};

export function createLegacyBlockedImportKey(issueId: string): string {
  return `legacy-blocked:v${LEGACY_BLOCKED_IMPORT_RULE_VERSION}:${issueId}`;
}
