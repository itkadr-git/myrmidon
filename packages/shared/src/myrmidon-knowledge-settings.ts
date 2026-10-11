// myrmidon(1.7 KNOWLEDGE-2.0 L-11): the "Settings → Knowledge" contract.
//
// Limits, auto-accept, the schedule and the section reviewers of the knowledge
// module, plus the UI / env / default badge every field carries. Shared by the
// server (the resolver and the routes) and the board screen, so the precedence
// and the bounds live in one place.
//
// Precedence, the same rule as the corpus module: a value saved from the
// screen wins; otherwise the matching environment variable; otherwise the
// default below. The badge reports which of the three produced the effective
// value. A saved value that is unreadable falls through to env, then default,
// and is reported as default — a broken row never becomes a runtime value.

import { z } from "zod";

/** Where an effective value came from. `ui` is a value saved from the screen. */
export const KNOWLEDGE_SETTING_SOURCES = ["ui", "env", "default"] as const;
export type KnowledgeSettingSource = (typeof KNOWLEDGE_SETTING_SOURCES)[number];

// Key of the stored object. The service persists the row in `knowledge_settings`;
// these helpers also read the same shape out of a generic record, so a vendor
// rewrite of `instance_settings.general` can keep the key if it is ever stored there.
export const KNOWLEDGE_SETTINGS_KEY = "knowledge" as const;

export const KNOWLEDGE_SETTINGS_ENV = {
  maxItems: "MYRMIDON_KNOWLEDGE_MAX_ITEMS",
  maxRevisionBytes: "MYRMIDON_KNOWLEDGE_MAX_REVISION_BYTES",
  autoAcceptEnabled: "MYRMIDON_KNOWLEDGE_AUTO_ACCEPT",
  autoAcceptMinConfidence: "MYRMIDON_KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE",
  schedule: "MYRMIDON_KNOWLEDGE_SCHEDULE",
} as const;

export const KNOWLEDGE_MAX_ITEMS_MIN = 1;
export const KNOWLEDGE_MAX_ITEMS_MAX = 100_000;
export const KNOWLEDGE_MAX_ITEMS_DEFAULT = 5_000;

export const KNOWLEDGE_MAX_REVISION_BYTES_MIN = 1_024;
export const KNOWLEDGE_MAX_REVISION_BYTES_MAX = 5_242_880;
export const KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT = 262_144;

export const KNOWLEDGE_AUTO_ACCEPT_DEFAULT = false;

/** Confidence is a fraction in [0, 1], stored and edited as a string. */
export const KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT = "0.9";

/** Five-field cron. The default never fires — the sweep stays off until chosen. */
export const KNOWLEDGE_SCHEDULE_DEFAULT = "0 0 0 0 0";

export const KNOWLEDGE_SCHEDULE_MAX_LENGTH = 64;

/** A section reviewer names a section (a folder path) and who reviews it. */
export interface KnowledgeSectionReviewer {
  /** Folder path of the section, e.g. `runbooks/oncall`. Empty is the root. */
  section: string;
  /** `user` or `agent`. */
  reviewerKind: "user" | "agent";
  /** The reviewer's id. */
  reviewerId: string;
}

export const KNOWLEDGE_SECTION_MAX_LENGTH = 200;
export const KNOWLEDGE_REVIEWER_ID_MAX_LENGTH = 200;
export const KNOWLEDGE_SECTION_REVIEWERS_MAX = 100;

/** The values the screen edits. Strings, so a half-typed number is not coerced. */
export interface KnowledgeSettingsInput {
  maxItems: string;
  maxRevisionBytes: string;
  autoAcceptEnabled: boolean;
  autoAcceptMinConfidence: string;
  schedule: string;
  sectionReviewers: KnowledgeSectionReviewer[];
}

/** One effective field: the value to use and which layer produced it. */
export interface KnowledgeSettingField<T> {
  value: T;
  source: KnowledgeSettingSource;
}

/** What `GET /api/myrmidon/knowledge/settings` returns. */
export interface KnowledgeSettingsView {
  maxItems: KnowledgeSettingField<number>;
  maxRevisionBytes: KnowledgeSettingField<number>;
  autoAcceptEnabled: KnowledgeSettingField<boolean>;
  autoAcceptMinConfidence: KnowledgeSettingField<string>;
  schedule: KnowledgeSettingField<string>;
  /** Section reviewers are a board choice: `ui` when any are saved, else `default`. */
  sectionReviewers: KnowledgeSettingField<KnowledgeSectionReviewer[]>;
}

export interface KnowledgeSettingsPatch {
  maxItems?: string;
  maxRevisionBytes?: string;
  autoAcceptEnabled?: boolean;
  autoAcceptMinConfidence?: string;
  schedule?: string;
  sectionReviewers?: KnowledgeSectionReviewer[];
}

/** The persisted row. Absent keys fall through to env, then the default. */
export interface KnowledgeSettingsStored {
  maxItems?: number;
  maxRevisionBytes?: number;
  autoAcceptEnabled?: boolean;
  autoAcceptMinConfidence?: string;
  schedule?: string;
  sectionReviewers?: KnowledgeSectionReviewer[];
}

export function defaultKnowledgeSettingsInput(): KnowledgeSettingsInput {
  return {
    maxItems: String(KNOWLEDGE_MAX_ITEMS_DEFAULT),
    maxRevisionBytes: String(KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT),
    autoAcceptEnabled: KNOWLEDGE_AUTO_ACCEPT_DEFAULT,
    autoAcceptMinConfidence: KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT,
    schedule: KNOWLEDGE_SCHEDULE_DEFAULT,
    sectionReviewers: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integer inside `[min, max]`, or null. Rejects leading zeros and partial numbers. */
export function parseKnowledgeBoundedInt(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/** A fraction in [0, 1] with at most four decimals, or null. */
export function parseKnowledgeConfidence(raw: string): string | null {
  const text = raw.trim();
  if (!/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/.test(text)) return null;
  return text;
}

const CRON_FIELD = /^(\*|\d{1,2})(\/\d{1,2})?$/;

/** Five cron fields, each a star or a number, optionally stepped. */
export function knowledgeScheduleOk(raw: string): boolean {
  const text = raw.trim();
  if (text.length === 0 || text.length > KNOWLEDGE_SCHEDULE_MAX_LENGTH) return false;
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => CRON_FIELD.test(field));
}

const knowledgeSectionReviewerSchema = z.object({
  section: z.string().max(KNOWLEDGE_SECTION_MAX_LENGTH),
  reviewerKind: z.enum(["user", "agent"]),
  reviewerId: z.string().trim().min(1).max(KNOWLEDGE_REVIEWER_ID_MAX_LENGTH),
});

/**
 * The stored shape. Lenient on purpose: a row with an unknown or unusable
 * value still parses, and the resolver decides what is usable, so a bad row
 * never fails a neighbouring settings block.
 */
export const storedKnowledgeSettingsSchema = z
  .object({
    maxItems: z.unknown().optional(),
    maxRevisionBytes: z.unknown().optional(),
    autoAcceptEnabled: z.unknown().optional(),
    autoAcceptMinConfidence: z.unknown().optional(),
    schedule: z.unknown().optional(),
    sectionReviewers: z.unknown().optional(),
  })
  .catchall(z.unknown());

/** The PATCH body. Strict, so a typo is a 400 rather than a silent drop. */
export const patchKnowledgeSettingsSchema = z
  .object({
    maxItems: z.string().trim().optional(),
    maxRevisionBytes: z.string().trim().optional(),
    autoAcceptEnabled: z.boolean().optional(),
    autoAcceptMinConfidence: z.string().trim().optional(),
    schedule: z.string().trim().max(KNOWLEDGE_SCHEDULE_MAX_LENGTH).optional(),
    sectionReviewers: z.array(knowledgeSectionReviewerSchema).max(KNOWLEDGE_SECTION_REVIEWERS_MAX).optional(),
  })
  .strict();

function reviewerOk(value: unknown): value is KnowledgeSectionReviewer {
  if (!isRecord(value)) return false;
  if (typeof value.section !== "string" || value.section.length > KNOWLEDGE_SECTION_MAX_LENGTH) return false;
  if (value.reviewerKind !== "user" && value.reviewerKind !== "agent") return false;
  if (typeof value.reviewerId !== "string") return false;
  const id = value.reviewerId.trim();
  return id.length > 0 && id.length <= KNOWLEDGE_REVIEWER_ID_MAX_LENGTH;
}

/** Reads a stored reviewer list, dropping rows that do not match the shape. */
export function readKnowledgeSectionReviewers(value: unknown): KnowledgeSectionReviewer[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > KNOWLEDGE_SECTION_REVIEWERS_MAX) return null;
  const reviewers: KnowledgeSectionReviewer[] = [];
  for (const row of value) {
    if (!reviewerOk(row)) return null;
    reviewers.push({
      section: row.section.trim(),
      reviewerKind: row.reviewerKind,
      reviewerId: row.reviewerId.trim(),
    });
  }
  return reviewers;
}

function readEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return text.length > 0 ? text : undefined;
}

function resolveInt(
  stored: number | undefined,
  envName: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv,
): KnowledgeSettingField<number> {
  if (typeof stored === "number" && Number.isSafeInteger(stored) && stored >= min && stored <= max) {
    return { value: stored, source: "ui" };
  }
  const fromEnv = readEnvString(env, envName);
  if (fromEnv !== undefined) {
    const parsed = parseKnowledgeBoundedInt(fromEnv, min, max);
    if (parsed !== null) return { value: parsed, source: "env" };
  }
  return { value: fallback, source: "default" };
}

function resolveBool(
  stored: boolean | undefined,
  envName: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv,
): KnowledgeSettingField<boolean> {
  if (typeof stored === "boolean") return { value: stored, source: "ui" };
  const fromEnv = readEnvString(env, envName);
  if (fromEnv !== undefined) {
    if (fromEnv === "1" || fromEnv.toLowerCase() === "true") return { value: true, source: "env" };
    if (fromEnv === "0" || fromEnv.toLowerCase() === "false") return { value: false, source: "env" };
  }
  return { value: fallback, source: "default" };
}

function resolveConfidence(
  stored: string | undefined,
  env: NodeJS.ProcessEnv,
): KnowledgeSettingField<string> {
  if (typeof stored === "string" && parseKnowledgeConfidence(stored) !== null) {
    return { value: stored, source: "ui" };
  }
  const fromEnv = readEnvString(env, KNOWLEDGE_SETTINGS_ENV.autoAcceptMinConfidence);
  if (fromEnv !== undefined && parseKnowledgeConfidence(fromEnv) !== null) {
    return { value: fromEnv, source: "env" };
  }
  return { value: KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT, source: "default" };
}

function resolveSchedule(stored: string | undefined, env: NodeJS.ProcessEnv): KnowledgeSettingField<string> {
  if (typeof stored === "string" && knowledgeScheduleOk(stored)) {
    return { value: stored.trim(), source: "ui" };
  }
  const fromEnv = readEnvString(env, KNOWLEDGE_SETTINGS_ENV.schedule);
  if (fromEnv !== undefined && knowledgeScheduleOk(fromEnv)) {
    return { value: fromEnv, source: "env" };
  }
  return { value: KNOWLEDGE_SCHEDULE_DEFAULT, source: "default" };
}

/**
 * Resolves the effective settings. `stored` is the saved object (or anything
 * else, which is treated as "nothing saved"). `env` defaults to `process.env`.
 */
export function resolveKnowledgeSettings(
  stored: unknown,
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeSettingsView {
  const row = isRecord(stored) ? stored : {};
  const reviewers = readKnowledgeSectionReviewers(row.sectionReviewers);
  return {
    maxItems: resolveInt(
      typeof row.maxItems === "number" ? row.maxItems : undefined,
      KNOWLEDGE_SETTINGS_ENV.maxItems,
      KNOWLEDGE_MAX_ITEMS_DEFAULT,
      KNOWLEDGE_MAX_ITEMS_MIN,
      KNOWLEDGE_MAX_ITEMS_MAX,
      env,
    ),
    maxRevisionBytes: resolveInt(
      typeof row.maxRevisionBytes === "number" ? row.maxRevisionBytes : undefined,
      KNOWLEDGE_SETTINGS_ENV.maxRevisionBytes,
      KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT,
      KNOWLEDGE_MAX_REVISION_BYTES_MIN,
      KNOWLEDGE_MAX_REVISION_BYTES_MAX,
      env,
    ),
    autoAcceptEnabled: resolveBool(
      typeof row.autoAcceptEnabled === "boolean" ? row.autoAcceptEnabled : undefined,
      KNOWLEDGE_SETTINGS_ENV.autoAcceptEnabled,
      KNOWLEDGE_AUTO_ACCEPT_DEFAULT,
      env,
    ),
    autoAcceptMinConfidence: resolveConfidence(
      typeof row.autoAcceptMinConfidence === "string" ? row.autoAcceptMinConfidence : undefined,
      env,
    ),
    schedule: resolveSchedule(typeof row.schedule === "string" ? row.schedule : undefined, env),
    sectionReviewers: reviewers && reviewers.length > 0
      ? { value: reviewers, source: "ui" }
      : { value: [], source: "default" },
  };
}

/** Field-level problems with a patch. Empty means the patch is usable. */
export function knowledgeSettingsPatchErrors(patch: KnowledgeSettingsPatch): string[] {
  const errors: string[] = [];
  if (patch.maxItems !== undefined && parseKnowledgeBoundedInt(patch.maxItems, KNOWLEDGE_MAX_ITEMS_MIN, KNOWLEDGE_MAX_ITEMS_MAX) === null) {
    errors.push("maxItems");
  }
  if (
    patch.maxRevisionBytes !== undefined
    && parseKnowledgeBoundedInt(patch.maxRevisionBytes, KNOWLEDGE_MAX_REVISION_BYTES_MIN, KNOWLEDGE_MAX_REVISION_BYTES_MAX) === null
  ) {
    errors.push("maxRevisionBytes");
  }
  if (patch.autoAcceptMinConfidence !== undefined && parseKnowledgeConfidence(patch.autoAcceptMinConfidence) === null) {
    errors.push("autoAcceptMinConfidence");
  }
  if (patch.schedule !== undefined && !knowledgeScheduleOk(patch.schedule)) {
    errors.push("schedule");
  }
  if (patch.sectionReviewers !== undefined && readKnowledgeSectionReviewers(patch.sectionReviewers) === null) {
    errors.push("sectionReviewers");
  }
  return errors;
}

/** Applies a valid patch onto the stored object. Caller has checked the errors. */
export function applyKnowledgeSettingsPatch(
  stored: KnowledgeSettingsStored,
  patch: KnowledgeSettingsPatch,
): KnowledgeSettingsStored {
  const next: KnowledgeSettingsStored = { ...stored };
  if (patch.maxItems !== undefined) {
    next.maxItems = parseKnowledgeBoundedInt(patch.maxItems, KNOWLEDGE_MAX_ITEMS_MIN, KNOWLEDGE_MAX_ITEMS_MAX)!;
  }
  if (patch.maxRevisionBytes !== undefined) {
    next.maxRevisionBytes = parseKnowledgeBoundedInt(
      patch.maxRevisionBytes,
      KNOWLEDGE_MAX_REVISION_BYTES_MIN,
      KNOWLEDGE_MAX_REVISION_BYTES_MAX,
    )!;
  }
  if (patch.autoAcceptEnabled !== undefined) next.autoAcceptEnabled = patch.autoAcceptEnabled;
  if (patch.autoAcceptMinConfidence !== undefined) {
    next.autoAcceptMinConfidence = parseKnowledgeConfidence(patch.autoAcceptMinConfidence)!;
  }
  if (patch.schedule !== undefined) next.schedule = patch.schedule.trim();
  if (patch.sectionReviewers !== undefined) {
    next.sectionReviewers = readKnowledgeSectionReviewers(patch.sectionReviewers)!;
  }
  return next;
}

/** Reads a stored settings object, ignoring keys that are not the stored shape. */
export function readStoredKnowledgeSettings(general: unknown): KnowledgeSettingsStored {
  if (!isRecord(general)) return {};
  const value = general[KNOWLEDGE_SETTINGS_KEY];
  if (!isRecord(value)) return {};
  const stored: KnowledgeSettingsStored = {};
  if (typeof value.maxItems === "number") stored.maxItems = value.maxItems;
  if (typeof value.maxRevisionBytes === "number") stored.maxRevisionBytes = value.maxRevisionBytes;
  if (typeof value.autoAcceptEnabled === "boolean") stored.autoAcceptEnabled = value.autoAcceptEnabled;
  if (typeof value.autoAcceptMinConfidence === "string") stored.autoAcceptMinConfidence = value.autoAcceptMinConfidence;
  if (typeof value.schedule === "string") stored.schedule = value.schedule;
  const reviewers = readKnowledgeSectionReviewers(value.sectionReviewers);
  if (reviewers) stored.sectionReviewers = reviewers;
  return stored;
}

/**
 * Keeps the stored knowledge settings across a vendor rewrite of a generic
 * settings record. Same contract as every other myrmidon key.
 */
export function preserveKnowledgeSettingsGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (!isRecord(storedGeneral)) return {};
  const value = storedGeneral[KNOWLEDGE_SETTINGS_KEY];
  return value === undefined ? {} : { [KNOWLEDGE_SETTINGS_KEY]: value };
}
