import { formatReport, loadReport } from "../../../packages/db/src/readdress-report.ts";

export { formatReport, loadReport, resolveAddresslessCard } from "../../../packages/db/src/readdress-report.ts";

async function main(argv: string[]): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const formatArg = argv.find((arg) => arg.startsWith("--format="))?.slice("--format=".length) ?? "json";
  if (formatArg !== "json" && formatArg !== "csv") {
    console.error("--format must be json or csv");
    return 2;
  }
  try {
    process.stdout.write(formatReport(await loadReport(url), formatArg));
    return 0;
  } catch (error) {
    console.error(`readdress-report failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
