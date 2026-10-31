import type {
  LocaleKeyDiffReport,
  LocaleValidationError,
  LocaleValidationResult,
} from "@myrmidon/shared";

export interface ValidateCatalogOptions {
  targetLocale?: string;
  baseLocale?: string;
  strict?: boolean;
  maxStringLength?: number;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function formatPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

export function extractPlaceholders(value: string): string[] {
  const matches = Array.from(
    value.matchAll(/(?:\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{\s*([A-Za-z0-9_.-]+)\s*\})/g),
    (match) => match[1] || match[2],
  );
  return Array.from(new Set(matches)).sort();
}

export function hasHtmlLikeTag(value: string): boolean {
  return /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*)?>/.test(value);
}

export function hasEventHandlerAttribute(value: string): boolean {
  return /\son[A-Za-z]+\s*=/i.test(value);
}

export function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi), (match) => match[0]).sort();
}

export function findDisallowedPayloads(value: string, baseValue?: string): string[] {
  const disallowed: string[] = [];
  const baseHasScript = baseValue ? /<script\b/i.test(baseValue) : false;
  const baseHasHtml = baseValue ? hasHtmlLikeTag(baseValue) : false;
  const baseHasJavascriptUri = baseValue ? /\bjavascript\s*:/i.test(baseValue) : false;
  const baseHasDataUri = baseValue ? /\bdata\s*:/i.test(baseValue) : false;

  if (/<script\b/i.test(value) && !baseHasScript) {
    disallowed.push("<script");
  }
  if (hasEventHandlerAttribute(value)) {
    disallowed.push("event-handler attribute");
  }
  if (/\bjavascript\s*:/i.test(value) && !baseHasJavascriptUri) {
    disallowed.push("javascript:");
  }
  if (/\bdata\s*:/i.test(value) && !baseHasDataUri) {
    disallowed.push("data:");
  }
  if (!baseHasHtml && hasHtmlLikeTag(value)) {
    disallowed.push("raw HTML tag");
  }

  const baseUrls = baseValue ? extractUrls(baseValue) : [];
  const candidateUrls = extractUrls(value);
  for (const url of candidateUrls) {
    if (!baseUrls.includes(url)) {
      disallowed.push("unexpected URL");
      break;
    }
  }

  return disallowed;
}

export function flattenCatalog(
  node: unknown,
  prefix = "",
  out: Map<string, string> = new Map(),
): Map<string, string> {
  if (typeof node === "string") {
    if (prefix) out.set(prefix, node);
    return out;
  }
  if (!isPlainObject(node)) {
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(nextPath, value);
    } else if (isPlainObject(value)) {
      flattenCatalog(value, nextPath, out);
    }
  }
  return out;
}

export function parseCatalogJson(raw: string | Buffer): {
  catalog?: Record<string, unknown>;
  error?: string;
} {
  const text = typeof raw === "string" ? raw : raw.toString("utf-8");
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        error:
          "Catalog root must be a JSON object, received " +
          (Array.isArray(parsed) ? "array" : typeof parsed),
      };
    }
    return { catalog: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Invalid JSON syntax: ${message}` };
  }
}

export function validateCatalog(
  candidateRaw: unknown,
  baseRaw?: unknown,
  options: ValidateCatalogOptions = {},
): LocaleValidationResult {
  const maxStringLength = options.maxStringLength ?? 4000;
  const targetLocale = options.targetLocale ?? "custom";
  const baseLocale = options.baseLocale ?? "en";
  const errors: LocaleValidationError[] = [];
  const warnings: string[] = [];

  const candidate = candidateRaw;
  if (!isPlainObject(candidate)) {
    const type = candidate === null ? "null" : Array.isArray(candidate) ? "array" : typeof candidate;
    errors.push({
      path: "<root>",
      code: "INVALID_ROOT",
      message: `Catalog root must be an object, received ${type}`,
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

  const baseMap = isPlainObject(baseRaw) ? flattenCatalog(baseRaw) : new Map<string, string>();
  const candidateMap = flattenCatalog(candidate);

  function walk(node: unknown, path: string[]) {
    if (path.length > 0 && path[path.length - 1] === "") {
      errors.push({
        path: formatPath(path),
        code: "EMPTY_KEY",
        message: "Key name cannot be empty string",
      });
    }

    if (typeof node === "string") {
      const fullPath = path.join(".");
      const baseValue = baseMap.get(fullPath);

      if (baseValue !== undefined) {
        const basePlaceholders = extractPlaceholders(baseValue);
        const candidatePlaceholders = extractPlaceholders(node);
        if (candidatePlaceholders.join("\0") !== basePlaceholders.join("\0")) {
          errors.push({
            path: fullPath,
            code: "PLACEHOLDER_MISMATCH",
            message: `Placeholder mismatch at "${fullPath}": expected [${basePlaceholders.join(
              ", ",
            )}], received [${candidatePlaceholders.join(", ")}]`,
          });
        }
      }

      const disallowed = findDisallowedPayloads(node, baseValue);
      if (disallowed.length > 0) {
        errors.push({
          path: fullPath,
          code: "DISALLOWED_PAYLOAD",
          message: `Disallowed content detected at "${fullPath}": ${disallowed.join(", ")}`,
        });
      }

      if (node.length > maxStringLength) {
        errors.push({
          path: fullPath,
          code: "STRING_TOO_LONG",
          message: `Translation string exceeds maximum length of ${maxStringLength} characters (length: ${node.length})`,
        });
      }
      return;
    }

    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...path, key]);
      }
      return;
    }

    const type = node === null ? "null" : Array.isArray(node) ? "array" : typeof node;
    errors.push({
      path: formatPath(path),
      code: "INVALID_TYPE",
      message: `Invalid node type at "${formatPath(path)}": expected string or nested object, received ${type}`,
    });
  }

  walk(candidate, []);

  const baseKeys = Array.from(baseMap.keys()).sort();
  const candidateKeys = Array.from(candidateMap.keys()).sort();

  const matchedKeys: string[] = [];
  const missingKeys: string[] = [];
  const extraKeys: string[] = [];

  for (const bKey of baseKeys) {
    if (candidateMap.has(bKey)) {
      matchedKeys.push(bKey);
    } else {
      missingKeys.push(bKey);
    }
  }

  for (const cKey of candidateKeys) {
    if (!baseMap.has(cKey)) {
      extraKeys.push(cKey);
    }
  }

  const totalBaseKeys = baseKeys.length;
  const totalCandidateKeys = candidateKeys.length;
  const matchedCount = matchedKeys.length;
  const missingCount = missingKeys.length;
  const extraCount = extraKeys.length;

  const coveragePercent =
    totalBaseKeys > 0 ? Math.round((matchedCount / totalBaseKeys) * 1000) / 10 : 100;

  if (options.strict && missingCount > 0) {
    for (const missingKey of missingKeys) {
      errors.push({
        path: missingKey,
        code: "MISSING_KEY" as any,
        message: `Missing required base translation key: "${missingKey}"`,
      });
    }
  }

  if (extraCount > 0) {
    warnings.push(
      `Catalog introduces ${extraCount} extra key(s) not present in base catalog: ${extraKeys
        .slice(0, 5)
        .join(", ")}${extraCount > 5 ? "..." : ""}`,
    );
  }

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

  return {
    valid: errors.length === 0,
    targetLocale,
    baseLocale,
    report,
    errors,
    warnings,
  };
}
