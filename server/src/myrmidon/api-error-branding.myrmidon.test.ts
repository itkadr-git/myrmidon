import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");

// Keep this list focused on user-facing prose. Compatibility identifiers such
// as PAPERCLIP_API_URL, paperclipApiUrl, X-Paperclip-Run-Id, legacy route paths,
// and stored audit-log descriptions are intentionally not covered by this
// regression guard. The license attribution is also an allowed exception.
const FORBIDDEN_API_ERROR_TEXT = [
  "Paperclip Cloud portfolio is not configured",
  "Paperclip Cloud portfolio request failed",
  "Paperclip Cloud portfolio returned invalid JSON",
  "Company creation is managed by Paperclip Cloud",
  "Paperclip Cloud enrollment requires a company",
  "Paperclip Cloud enrollment could not be started",
  "Invalid Paperclip Cloud enrollment callback",
  "Paperclip Cloud enrollment not found",
  "Invalid or expired Paperclip Cloud enrollment callback",
  "X-Paperclip-Run-Id does not match signed agent JWT run_id",
  "External grants cannot also contain Paperclip secret references",
  "paperclipApiUrl must use http:// or https://",
  "Invalid paperclipApiUrl:",
  "paperclipApiUrl set to",
  "company through Paperclip.",
  "Apply the onboarding seed Paperclip Cloud collected at signup",
  "Handle a brokered Paperclip Cloud OAuth callback",
  "Handle a legacy brokered Paperclip ID OAuth callback",
  "Get Paperclip Cloud connector enrollment status",
  "Start Paperclip Cloud connector enrollment",
  "Complete Paperclip Cloud connector enrollment",
];

const SOURCE_FILES = [
  "server/src/routes/access.ts",
  "server/src/routes/board-chat.ts",
  "server/src/routes/cloud.ts",
  "server/src/routes/companies.ts",
  "server/src/routes/openapi.ts",
  "server/src/routes/tool-access.ts",
  "server/src/middleware/auth.ts",
  "packages/shared/src/validators/tool-access.ts",
];

describe("API error text branding", () => {
  it("does not expose legacy Paperclip prose in API surfaces", () => {
    const findings: string[] = [];
    for (const relativePath of SOURCE_FILES) {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      for (const text of FORBIDDEN_API_ERROR_TEXT) {
        if (source.includes(text)) findings.push(`${relativePath}: ${text}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
