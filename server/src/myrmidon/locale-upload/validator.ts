// myrmidon(1.7 LOCALE-UPLOAD): server-side catalog validator integration
import { existsSync, readFileSync } from "node:fs";
import {
  extractPlaceholders,
  flattenCatalog,
  isPlainObject,
  parseCatalogJson,
  validateCatalogStructure,
  type LocaleValidationResult,
  type ValidateCatalogOptions,
} from "@myrmidon/shared";

export type { ValidateCatalogOptions } from "@myrmidon/shared";

export {
  parseCatalogJson,
  extractPlaceholders,
  flattenCatalog,
  lintStringValue,
  validateCatalogStructure,
  isPlainObject,
} from "@myrmidon/shared";

let cachedReferenceCatalog: Record<string, unknown> | null = null;

export function validateCatalog(
  candidate: unknown,
  baseCatalog: Record<string, unknown>,
  options: ValidateCatalogOptions = {},
): LocaleValidationResult {
  return validateCatalogStructure(candidate, { ...options, baseCatalog });
}

export function formatPath(parts: string[]): string {
  return parts.filter(Boolean).join(".") || "<root>";
}

export function findDisallowedPayloads(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const findings: string[] = [];
  if (/<script\b/i.test(value)) findings.push("<script");
  if (/\son[a-zA-Z]+\s*=/i.test(value)) findings.push("event-handler attribute");
  if (/\b(?:javascript|data|vbscript)\s*:/i.test(value)) findings.push("javascript:/data: URL");
  return findings;
}

export function loadBaseReferenceCatalog(customPath?: string): Record<string, unknown> {
  if (!customPath && cachedReferenceCatalog) {
    return cachedReferenceCatalog;
  }

  const referenceUrl = customPath ? new URL(customPath, import.meta.url) : new URL("./en-reference.json", import.meta.url);

  try {
    if (!existsSync(referenceUrl)) {
      throw new Error(`File not found: ${referenceUrl.toString()}`);
    }
    const raw = readFileSync(referenceUrl, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Reference catalog root must be a JSON object");
    }
    if (!customPath) {
      cachedReferenceCatalog = parsed as Record<string, unknown>;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to load base English catalog: reference file not found or invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export function validateUploadedCatalog(
  candidate: unknown,
  options: ValidateCatalogOptions = {},
): LocaleValidationResult {
  const baseCatalog =
    options.baseCatalog !== undefined ? options.baseCatalog : loadBaseReferenceCatalog();

  return validateCatalogStructure(candidate, {
    ...options,
    baseCatalog,
  });
}
