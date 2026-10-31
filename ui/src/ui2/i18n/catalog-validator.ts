// myrmidon(1.7 LOCALE-UPLOAD, OPE-10187): UI client catalog linter and validator utilities
import {
  parseCatalogJson,
  validateCatalogStructure,
  flattenCatalog,
  type LocaleValidationResult,
  type ValidateCatalogOptions,
} from \"@myrmidon/shared\";

export interface CatalogValidationSummary {
  status: \"valid\" | \"invalid\";
  valid: boolean;
  summary: string;
  matchedCount: number;
  totalCandidateKeys: number;
  coveragePercent: number;
  errorMessages: string[];
  warningMessages: string[];
}

export function validateCatalogJsonContent(
  jsonContent: string,
  options: ValidateCatalogOptions = {},
): LocaleValidationResult {
  const parsed = parseCatalogJson(jsonContent, options.maxByteSize);
  if (parsed.error || !parsed.catalog) {
    return {
      valid: false,
      targetLocale: options.targetLocale || \"custom\",
      baseLocale: options.baseLocale || \"en\",
      report: {
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
      },
      errors: [
        {
          path: \"<root>\",
          code: \"PARSE_ERROR\",
          message: parsed.error || \"Failed to parse catalog JSON\",
        },
      ],
      warnings: [],
    };
  }

  return validateCatalogStructure(parsed.catalog, options);
}

export function previewCatalogEntries(
  catalog: Record<string, unknown>,
  limit = 20,
): Array<{ path: string; value: string }> {
  const { entries } = flattenCatalog(catalog);
  const result: Array<{ path: string; value: string }> = [];
  let count = 0;
  for (const [path, value] of entries) {
    if (count >= limit) break;
    result.push({ path, value });
    count++;
  }
  return result;
}

export function formatValidationSummary(result: LocaleValidationResult): CatalogValidationSummary {
  const errorMessages = result.errors.map((e) => `[${e.code}] ${e.path}: ${e.message}`);
  const warningMessages = result.warnings.map((w) => `[${w.code}] ${w.path}: ${w.message}`);

  const summary = result.valid
    ? `Catalog is valid for locale '${result.targetLocale}'. Matched ${result.report.matchedCount} keys (${result.report.coveragePercent}% coverage).`
    : `Catalog has ${result.errors.length} validation error(s) and cannot be uploaded.`;

  return {
    status: result.valid ? \"valid\" : \"invalid\",
    valid: result.valid,
    summary,
    matchedCount: result.report.matchedCount,
    totalCandidateKeys: result.report.totalCandidateKeys,
    coveragePercent: result.report.coveragePercent,
    errorMessages,
    warningMessages,
  };
}
