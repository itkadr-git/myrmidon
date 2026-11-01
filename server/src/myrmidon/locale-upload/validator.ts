// myrmidon(1.7 LOCALE-UPLOAD): server-side catalog validator integration
import { existsSync, readFileSync } from "node:fs";
import {
  parseCatalogJson,
  validateCatalogStructure,
  type LocaleValidationResult,
  type ValidateCatalogOptions,
} from "@myrmidon/shared";

export {
  parseCatalogJson,
  extractPlaceholders,
  flattenCatalog,
  lintStringValue,
  validateCatalogStructure,
} from "@myrmidon/shared";

let cachedReferenceCatalog: Record<string, unknown> | null = null;

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
