import {
  applyReaddress,
  computeRouteType,
  computeTimeoutAt,
  formatApplySummary,
  type ReaddressApplyItem,
  type ReaddressApplyOptions,
  type ReaddressApplyResult,
} from "../../../packages/db/src/readdress-apply.js";

export {
  applyReaddress,
  computeRouteType,
  computeTimeoutAt,
  formatApplySummary,
  type ReaddressApplyItem,
  type ReaddressApplyOptions,
  type ReaddressApplyResult,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hasDryRun = args.includes("--dry-run");
  const hasApply = args.includes("--apply");

  if (hasDryRun && hasApply) {
    console.error("Error: --dry-run and --apply are mutually exclusive");
    process.exit(2);
  }

  // Dry-run is the default unless --apply is explicitly specified
  const dryRun = !hasApply;
  const format = args.includes("--json") ? "json" : args.includes("--csv") ? "csv" : "text";

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Error: DATABASE_URL is required");
    process.exit(1);
  }

  const result = await applyReaddress(databaseUrl, { dryRun });
  console.log(formatApplySummary(result, format));
}

if (process.argv[1]?.endsWith("readdress-apply.ts") || process.argv[1]?.endsWith("readdress-apply.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
