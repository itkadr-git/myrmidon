import { createHash } from "node:crypto";
import type { CompanyPortabilityExport } from "@myrmidon/shared";

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
}

export function migrationRunKey(input: {
  sourceCompanyId: string;
  targetName: string;
  collisionStrategy: "rename" | "skip" | "replace";
  exportOptions: CompanyPortabilityExport;
  files: Record<string, unknown>;
  secretBindings?: Array<{ key: string; agentSlug: string | null; projectSlug: string | null; requirement: string }>;
}): string {
  // Binding order is an export traversal detail, not migration identity.
  const normalized = {
    ...input,
    secretBindings: [...(input.secretBindings ?? [])].sort((left, right) => {
      const a = canonicalJson(left);
      const b = canonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  };
  // Hash package files instead of the parsed manifest's volatile generatedAt timestamp.
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
