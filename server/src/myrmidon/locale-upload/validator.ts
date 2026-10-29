import type {
  LocaleKeyDiffReport,
  LocaleValidationError,
  LocaleValidationResult,
} from \"@myrmidon/shared\";

export const MAX_CATALOG_STRING_LENGTH = 2_000;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === \"object\" && !Array.isArray(value);
}

export function formatPath(path: string[]): string {
  return path.length > 0 ? path.join(\".\") : \"<root>\";
}

export function extractPlaceholders(value: string): string[] {
  return Array.from(
    value.matchAll(/(?:\\{\\{\\s*([A-Za-z0-9_.-]+)\\s*\\}\\}|\\{\\s*([A-Za-z0-9_.-]+)\\s*\\})/g),
    (match) => match[1] || match[2],
  ).sort();
}

function hasRawHtml(value: string): boolean {
  return /<\\/?[A-Za-z][A-Za-z0-9:-]*(?:\\s[^>]*)?>/.test(value);
}

function hasEventHandlerAttribute(value: string): boolean {
  return /\\son[A-Za-z]+\\s*=/i.test(value);
}

function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/\\bhttps?:\\/\\/[^\\s<>\"')]+/gi), (match) => match[0]).sort();
}

export function findDisallowedPayloads(value: string, baseValue?: string): string[] {
  const baseHasScript = baseValue ? /<script\\b/i.test(baseValue) : false;
  const baseHasEventHandler = baseValue ? hasEventHandlerAttribute(baseValue) : false;
  const baseHasJavascriptUri = baseValue ? /\\bjavascript\\s*:/i.test(baseValue) : false;
  const baseHasDataUri = baseValue ? /\\bdata\\s*:/i.test(baseValue) : false;
  const baseHasRawHtml = baseValue ? hasRawHtml(baseValue) : false;

  const disallowed: string[] = [];
  if (/<script\\b/i.test(value) && !baseHasScript) {
    disallowed.push(\"<script\");
  }
  if (hasEventHandlerAttribute(value) && !baseHasEventHandler) {
    disallowed.push(\"event-handler attribute\");
  }
  if (/\\bjavascript\\s*:/i.test(value) && !baseHasJavascriptUri) {
    disallowed.push(\"javascript:\");
  }
  if (/\\bdata\\s*:/i.test(value) && !baseHasDataUri) {
    disallowed.push(\"data:\");
  }
  if (hasRawHtml(value) && !baseHasRawHtml) {
    disallowed.push(\"raw HTML tag\");
  }

  if (baseValue) {
    const baseUrls = new Set(extractUrls(baseValue));
    const unexpectedUrl = extractUrls(value).find((url) => !baseUrls.has(url));
    if (unexpectedUrl) {
      disallowed.push(\"unexpected URL\");
    }
  }

  return disallowed;
}

export function flattenCatalog(
  node: unknown,
  prefix = \"\",
  acc: Map<string, string> = new Map(),
): Map<string, string> {
  if (typeof node === \"string\") {
    if (prefix) acc.set(prefix, node);
    return acc;
  }
  if (!isPlainObject(node)) {
    return acc;
  }
  for (const [key, value] of Object.entries(node)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === \"string\") {
      acc.set(nextKey, value);
    } else if (isPlainObject(value)) {
      flattenCatalog(value, nextKey, acc);
    }
  }
  return acc;
}

export function parseCatalogJson(raw: string | Buffer): {
  catalog: Record<string, unknown> | null;
  error: string | null;
} {
  const text = typeof raw === \"string\" ? raw : raw.toString(\"utf-8\");
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        catalog: null,
        error: \"Catalog root must be a JSON object, received \" + (Array.isArray(parsed) ? \"array\" : typeof parsed),
      };
    }
    return { catalog: parsed, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { catalog: null, error: `Invalid JSON syntax: ${message}` };
  }
}

export interface ValidateCatalogOptions {
  targetLocale?: string;
  baseLocale?: string;
  strict?: boolean;
}

export function validateCatalog(
  candidate: unknown,
  baseCatalog: Record<string, unknown>,
  options: ValidateCatalogOptions = {},
): LocaleValidationResult {
  const targetLocale = options.targetLocale ?? \"custom\";
  const baseLocale = options.baseLocale ?? \"en\";
  const errors: LocaleValidationError[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(candidate)) {
    const type = candidate === null ? \"null\" : Array.isArray(candidate) ? \"array\" : typeof candidate;
    errors.push({
      path: \"<root>\",
      code: \"INVALID_ROOT\",
      message: `Catalog root must be a JSON object, received ${type}`,
    });

    const emptyReport: LocaleKeyDiffReport = {
      totalBaseKeys: flattenCatalog(baseCatalog).size,
      totalCandidateKeys: 0,
      matchedCount: 0,
      missingCount: flattenCatalog(baseCatalog).size,
      extraCount: 0,
      coveragePercent: 0,
      matchedKeys: [],
      missingKeys: Array.from(flattenCatalog(baseCatalog).keys()).sort(),
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

  const baseMap = flattenCatalog(baseCatalog);
  const baseKeys = Array.from(baseMap.keys()).sort();
  const baseKeySet = new Set(baseKeys);

  const candidateMap = new Map<string, string>();

  function walk(path: string[], node: unknown) {
    if (path.length > 0 && path[path.length - 1] === \"\") {
      errors.push({
        path: formatPath(path),
        code: \"EMPTY_KEY\",
        message: `${formatPath(path)} key cannot be empty`,
      });
    }

    if (typeof node === \"string\") {
      const fullPath = path.join(\".\");
      candidateMap.set(fullPath, node);

      const baseVal = baseMap.get(fullPath);
      if (baseVal !== undefined) {
        const candidatePlaceholders = extractPlaceholders(node);
        const basePlaceholders = extractPlaceholders(baseVal);
        if (candidatePlaceholders.join(\"\\0\") !== basePlaceholders.join(\"\\0\")) {
          errors.push({
            path: fullPath,
            code: \"PLACEHOLDER_MISMATCH\",
            message: `${fullPath} interpolation placeholders must match base locale: expected ${JSON.stringify(
              basePlaceholders,
            )}, received ${JSON.stringify(candidatePlaceholders)}`,
          });
        }
      }

      const disallowed = findDisallowedPayloads(node, baseVal);
      for (const payload of disallowed) {
        errors.push({
          path: fullPath,
          code: \"DISALLOWED_PAYLOAD\",
          message: `${fullPath} contains disallowed ${payload}`,
        });
      }

      const lengthLimit = baseVal
        ? Math.min(MAX_CATALOG_STRING_LENGTH, Math.max(baseVal.length * 4 + 64, baseVal.length + 128))
        : MAX_CATALOG_STRING_LENGTH;

      if (node.length > lengthLimit) {
        errors.push({
          path: fullPath,
          code: \"STRING_TOO_LONG\",
          message: `${fullPath} is too long: ${node.length} characters exceeds limit of ${lengthLimit}`,
        });
      }
      return;
    }

    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk([...path, key], value);
      }
      return;
    }

    const type = node === null ? \"null\" : Array.isArray(node) ? \"array\" : typeof node;
    errors.push({
      path: formatPath(path),
      code: \"INVALID_TYPE\",
      message: `${formatPath(path)} must be a string or object, received ${type}`,
    });
  }

  walk([], candidate);

  const candidateKeys = Array.from(candidateMap.keys()).sort();
  const candidateKeySet = new Set(candidateKeys);

  const matchedKeys: string[] = [];
  const missingKeys: string[] = [];
  const extraKeys: string[] = [];

  for (const key of baseKeys) {
    if (candidateKeySet.has(key)) {
      matchedKeys.push(key);
    } else {
      missingKeys.push(key);
    }
  }

  for (const key of candidateKeys) {
    if (!baseKeySet.has(key)) {
      extraKeys.push(key);
    }
  }

  const newKeys = [...extraKeys];

  const matchedCount = matchedKeys.length;
  const missingCount = missingKeys.length;
  const extraCount = extraKeys.length;
  const totalBaseKeys = baseKeys.length;
  const totalCandidateKeys = candidateKeys.length;
  const coveragePercent = totalBaseKeys > 0 ? Math.round((matchedCount / totalBaseKeys) * 100) : 100;

  if (missingCount > 0) {
    warnings.push(`${missingCount} keys are missing compared to base locale (${baseLocale})`);
  }
  if (extraCount > 0) {
    warnings.push(`${extraCount} extra keys not present in base locale (${baseLocale})`);
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
    newKeys,
  };

  let valid = errors.length === 0;
  if (options.strict && (missingCount > 0 || extraCount > 0)) {
    valid = false;
  }

  return {
    valid,
    targetLocale,
    baseLocale,
    report,
    errors,
    warnings,
  };
}
