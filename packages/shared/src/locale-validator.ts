// myrmidon(1.7 LOCALE-UPLOAD): localization catalog structure linter, validator and diff reporter.
import { z } from "zod";

export const LOCALE_VALIDATION_ERROR_CODES = [
  "INVALID_ROOT",
  "INVALID_KEY",
  "INVALID_TYPE",
  "NESTING_TOO_DEEP",
  "DISALLOWED_PAYLOAD",
  "STRING_TOO_LONG",
  "PLACEHOLDER_SYNTAX_ERROR",
  "PLACEHOLDER_MISMATCH",
  "PARSE_ERROR",
] as const;

export type LocaleValidationErrorCode = (typeof LOCALE_VALIDATION_ERROR_CODES)[number];

export const localeValidationErrorCodeSchema = z.enum(LOCALE_VALIDATION_ERROR_CODES);

export const LOCALE_VALIDATION_WARNING_CODES = [
  "EMPTY_TRANSLATION",
  "SUSPICIOUS_WHITESPACE",
  "EXTRA_KEY",
  "MISSING_KEY",
] as const;

export type LocaleValidationWarningCode = (typeof LOCALE_VALIDATION_WARNING_CODES)[number];

export const localeValidationWarningCodeSchema = z.enum(LOCALE_VALIDATION_WARNING_CODES);

export const localeValidationErrorSchema = z.object({
  path: z.string(),
  code: localeValidationErrorCodeSchema,
  message: z.string(),
});

export type LocaleValidationError = z.infer<typeof localeValidationErrorSchema>;

export const localeValidationWarningSchema = z.object({
  path: z.string(),
  code: localeValidationWarningCodeSchema,
  message: z.string(),
});

export type LocaleValidationWarning = z.infer<typeof localeValidationWarningSchema>;

export const localeKeyDiffReportSchema = z.object({
  totalBaseKeys: z.number(),
  totalCandidateKeys: z.number(),
  matchedCount: z.number(),
  missingCount: z.number(),
  extraCount: z.number(),
  coveragePercent: z.number(),
  matchedKeys: z.array(z.string()),
  missingKeys: z.array(z.string()),
  extraKeys: z.array(z.string()),
  newKeys: z.array(z.string()),
});

export type LocaleKeyDiffReport = z.infer<typeof localeKeyDiffReportSchema>;

export const localeValidationResultSchema = z.object({
  valid: z.boolean(),
  targetLocale: z.string(),
  baseLocale: z.string(),
  report: localeKeyDiffReportSchema,
  errors: z.array(localeValidationErrorSchema),
  warnings: z.array(localeValidationWarningSchema),
});

export type LocaleValidationResult = z.infer<typeof localeValidationResultSchema>;

export const validateCatalogInputSchema = z.object({
  locale: z.string().min(2).max(35).regex(/^[a-zA-Z0-9_-]+$/),
  catalog: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  strict: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  baseLocale: z.string().optional(),
});

export type ValidateCatalogInput = z.infer<typeof validateCatalogInputSchema>;

export interface ValidateCatalogOptions {
  targetLocale?: string;
  baseLocale?: string;
  baseCatalog?: Record<string, unknown> | null;
  strict?: boolean;
  maxByteSize?: number;
  maxStringLength?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_BYTE_SIZE = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_STRING_LENGTH = 2000;
const DEFAULT_MAX_DEPTH = 10;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCatalogJson(
  content: string | Buffer,
  maxBytes = DEFAULT_MAX_BYTE_SIZE,
): { catalog: Record<string, unknown> | null; error?: string } {
  const byteLength = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
  if (byteLength > maxBytes) {
    return {
      catalog: null,
      error: `Catalog size (${byteLength} bytes) exceeds maximum limit of ${maxBytes} bytes`,
    };
  }

  const text = typeof content === "string" ? content : content.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        catalog: null,
        error: "Root catalog element must be a JSON object",
      };
    }
    return { catalog: parsed };
  } catch (err) {
    return {
      catalog: null,
      error: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function extractPlaceholders(text: string): string[] {
  const doubleMatches = Array.from(text.matchAll(/\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}/g), (m) => m[1]);
  // Also collect single {param} placeholders if not inside {{...}}
  const withoutDoubles = text.replace(/\\{\\{\\s*[a-zA-Z0-9_.-]+\\s*\\}\\}/g, "");
  const singleMatches = Array.from(withoutDoubles.matchAll(/\\{([a-zA-Z0-9_.-]+)\\}/g), (m) => m[1]);
  return [...new Set([...doubleMatches, ...singleMatches])].sort();
}

export function flattenCatalog(
  source: Record<string, unknown>,
  prefix = "",
  depth = 1,
  maxDepth = DEFAULT_MAX_DEPTH,
): { entries: Map<string, string>; depthErrors: string[] } {
  const entries = new Map<string, string>();
  const depthErrors: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (depth > maxDepth) {
      depthErrors.push(path);
      continue;
    }
    if (isPlainObject(value)) {
      const child = flattenCatalog(value, path, depth + 1, maxDepth);
      depthErrors.push(...child.depthErrors);
      for (const [k, v] of child.entries) {
        entries.set(k, v);
      }
    } else if (typeof value === "string") {
      entries.set(path, value);
    }
  }

  return { entries, depthErrors };
}

function hasDisallowedPayloads(value: string, baseValue?: string): string[] {
  const checks: Array<[boolean, boolean, string]> = [
    [/<script\\b/i.test(value), Boolean(baseValue && /<script\\b/i.test(baseValue)), "<script tag"],
    [/\\son[a-zA-Z]+\\s*=/i.test(value), Boolean(baseValue && /\\son[a-zA-Z]+\\s*=/i.test(baseValue)), "event-handler attribute"],
    [/\\b(?:javascript|data|vbscript)\\s*:/i.test(value), Boolean(baseValue && /\\b(?:javascript|data|vbscript)\\s*:/i.test(baseValue)), "javascript:/data: URL"],
  ];

  return checks
    .filter(([cand, base]) => cand && !base)
    .map(([, , name]) => name);
}

function checkPlaceholderSyntax(value: string): string | null {
  // Check for unmatched {{ without }}
  const textWithoutValidDoubles = value.replace(/\\{\\{\\s*[a-zA-Z0-9_.-]+\\s*\\}\\}/g, "");
  if (/\\{\\{/.test(textWithoutValidDoubles) || /\\}\\}/.test(textWithoutValidDoubles)) {
    return "Unbalanced or malformed double braces {{...}}";
  }
  // Check for unmatched single { without }
  const textWithoutValidSingles = textWithoutValidDoubles.replace(/\\{[a-zA-Z0-9_.-]+\\}/g, "");
  if (/\\{/.test(textWithoutValidSingles) || /\\}/.test(textWithoutValidSingles)) {
    return "Unbalanced or malformed single brace {...}";
  }
  return null;
}

export function lintStringValue(
  path: string,
  value: string,
  baseValue?: string,
  options?: { maxStringLength?: number },
): { errors: LocaleValidationError[]; warnings: LocaleValidationWarning[] } {
  const errors: LocaleValidationError[] = [];
  const warnings: LocaleValidationWarning[] = [];
  const maxLen = options?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  // 1. Disallowed payloads
  const payloads = hasDisallowedPayloads(value, baseValue);
  for (const p of payloads) {
    errors.push({
      path,
      code: "DISALLOWED_PAYLOAD",
      message: `${path} contains disallowed ${p}`,
    });
  }

  // 2. Length limits
  const relativeLimit = baseValue
    ? Math.min(maxLen, Math.max(baseValue.length * 4 + 64, baseValue.length + 128))
    : maxLen;
  if (value.length > relativeLimit) {
    errors.push({
      path,
      code: "STRING_TOO_LONG",
      message: `${path} length (${value.length}) exceeds maximum allowed length of ${relativeLimit}`,
    });
  }

  // 3. Placeholder syntax
  const syntaxErr = checkPlaceholderSyntax(value);
  if (syntaxErr) {
    errors.push({
      path,
      code: "PLACEHOLDER_SYNTAX_ERROR",
      message: `${path} has syntax error in placeholder: ${syntaxErr}`,
    });
  }

  // 4. Placeholder parity with base
  if (baseValue !== undefined) {
    const candPlaceholders = extractPlaceholders(value);
    const basePlaceholders = extractPlaceholders(baseValue);
    if (candPlaceholders.join("\\u0000") !== basePlaceholders.join("\\u0000")) {
      errors.push({
        path,
        code: "PLACEHOLDER_MISMATCH",
        message: `${path} placeholders must match base catalog: expected [${basePlaceholders.join(", ")}], received [${candPlaceholders.join(", ")}]`,
      });
    }
  }

  // 5. Warnings: empty translation or leading/trailing whitespace
  if (value.trim().length === 0) {
    warnings.push({
      path,
      code: "EMPTY_TRANSLATION",
      message: `${path} has an empty or whitespace-only translation`,
    });
  } else if (value !== value.trim()) {
    warnings.push({
      path,
      code: "SUSPICIOUS_WHITESPACE",
      message: `${path} contains untrimmed leading or trailing whitespace`,
    });
  }

  return { errors, warnings };
}

export function validateCatalogStructure(
  candidate: unknown,
  options: ValidateCatalogOptions = {},
): LocaleValidationResult {
  const targetLocale = options.targetLocale || "custom";
  const baseLocale = options.baseLocale || "en";
  const strict = Boolean(options.strict);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

  const errors: LocaleValidationError[] = [];
  const warnings: LocaleValidationWarning[] = [];

  // Root validation
  if (!isPlainObject(candidate)) {
    errors.push({
      path: "<root>",
      code: "INVALID_ROOT",
      message: "Localization catalog must be a non-null, non-array JSON object",
    });
    const emptyReport: LocaleKeyDiffReport = {
      totalBaseKeys: 0,
      totalCandidateKeys: 0,
      matchedCount: 0,
      missingCount: 0,
      extraCount: 0,
      coveragePercent: 0,
      matchedKeys: [],
      missingKeys: [],
      extraKeys: [],
      newKeys: [],
    };
    return {
      valid: false,
      targetLocale,
      baseLocale,
      report: emptyReport,
      errors,
      warnings,
    };
  }

  // Recursive walk checking keys, types, and structure
  function walk(obj: Record<string, unknown>, prefix: string, currentDepth: number) {
    if (currentDepth > maxDepth) {
      errors.push({
        path: prefix,
        code: "NESTING_TOO_DEEP",
        message: `Catalog nesting exceeds maximum allowed depth of ${maxDepth} at ${prefix}`,
      });
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;

      // Key checks
      if (!key || key.trim().length === 0) {
        errors.push({
          path: prefix || "<root>",
          code: "INVALID_KEY",
          message: `Empty key name at ${prefix || "<root>"}`,
        });
        continue;
      }
      if (FORBIDDEN_KEYS.has(key)) {
        errors.push({
          path,
          code: "INVALID_KEY",
          message: `Forbidden prototype property key '${key}' at ${path}`,
        });
        continue;
      }
      if (key.length > 160) {
        errors.push({
          path,
          code: "INVALID_KEY",
          message: `Key length exceeds 160 characters at ${path}`,
        });
      }

      // Value type checks
      if (isPlainObject(value)) {
        walk(value, path, currentDepth + 1);
      } else if (typeof value === "string") {
        // leaf string value
      } else {
        errors.push({
          path,
          code: "INVALID_TYPE",
          message: `Value at ${path} must be a string or nested object, got ${Array.isArray(value) ? "array" : typeof value}`,
        });
      }
    }
  }

  walk(candidate, "", 1);

  // Flatten candidate and base
  const candidateFlat = flattenCatalog(candidate, "", 1, maxDepth).entries;
  const baseFlat = options.baseCatalog
    ? flattenCatalog(options.baseCatalog, "", 1, maxDepth).entries
    : new Map<string, string>();

  // Lint all string values
  for (const [path, value] of candidateFlat) {
    const baseValue = baseFlat.get(path);
    const lintRes = lintStringValue(path, value, baseValue, { maxStringLength });
    errors.push(...lintRes.errors);
    warnings.push(...lintRes.warnings);
  }

  // Diff report against base catalog
  const candidateKeys = [...candidateFlat.keys()].sort();
  const baseKeys = [...baseFlat.keys()].sort();

  const candidateKeySet = new Set(candidateKeys);
  const baseKeySet = new Set(baseKeys);

  const matchedKeys = baseKeys.filter((k) => candidateKeySet.has(k));
  const missingKeys = baseKeys.filter((k) => !candidateKeySet.has(k));
  const extraKeys = candidateKeys.filter((k) => !baseKeySet.has(k));

  const totalBaseKeys = baseKeys.length;
  const totalCandidateKeys = candidateKeys.length;
  const matchedCount = matchedKeys.length;
  const missingCount = missingKeys.length;
  const extraCount = extraKeys.length;
  const coveragePercent =
    totalBaseKeys > 0 ? Number(((matchedCount / totalBaseKeys) * 100).toFixed(1)) : 100;

  const report: LocaleKeyDiffReport = {
    totalBaseKeys,
    totalCandidateKeys,
    matchedCount,
    missingCount,
    extraCount,
    coveragePercent,
    matchedKeys,
    missingKeys,
    extraKeys,
    newKeys: extraKeys,
  };

  // Warnings / strict mode enforcement for diff
  if (baseKeys.length > 0) {
    for (const key of missingKeys) {
      if (strict) {
        errors.push({
          path: key,
          code: "INVALID_ROOT",
          message: `Missing required key in strict mode: ${key}`,
        });
      } else {
        warnings.push({
          path: key,
          code: "MISSING_KEY",
          message: `Key is missing from candidate catalog: ${key}`,
        });
      }
    }

    for (const key of extraKeys) {
      if (strict) {
        errors.push({
          path: key,
          code: "INVALID_KEY",
          message: `Unexpected extra key in strict mode: ${key}`,
        });
      } else {
        warnings.push({
          path: key,
          code: "EXTRA_KEY",
          message: `Key is not defined in base catalog: ${key}`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    targetLocale,
    baseLocale,
    report,
    errors,
    warnings,
  };
}
