// Pre-merge i18n guard on every CI tier (previously a host pre-merge check): run the repo guard scanner
// on every file listed in ui/src/i18n/guarded/*.txt and check area keys exist in the en catalogs.
// usage: node --experimental-strip-types scripts/myrmidon/i18n/precheck.mts [ui/src dir]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export interface GuardIssue {
  kind: "MISSING" | "ENGLISH" | "NOKEY";
  rel: string;
  line?: number;
  message: string;
}

export function flattenCatalog(obj: Record<string, unknown>, prefix = "", target: Record<string, number> = {}): Record<string, number> {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      flattenCatalog(v as Record<string, unknown>, prefix + k + ".", target);
    } else {
      target[prefix + k] = 1;
    }
  }
  return target;
}

export function loadEnCatalogs(uiSrc: string): Record<string, number> {
  const en: Record<string, number> = {};
  const areasDir = join(uiSrc, "i18n/myrmidon-locales/areas");
  if (existsSync(areasDir)) {
    for (const f of readdirSync(areasDir).filter((file) => file.endsWith(".en.json"))) {
      flattenCatalog(JSON.parse(readFileSync(join(areasDir, f), "utf8")), "", en);
    }
  }

  const base = join(uiSrc, "i18n/myrmidon-locales/en.json");
  if (existsSync(base)) {
    flattenCatalog(JSON.parse(readFileSync(base, "utf8")), "", en);
  }

  return en;
}

export function findGuardedFiles(guardedDir: string): string[] {
  if (!existsSync(guardedDir)) return [];
  return readdirSync(guardedDir)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("_"))
    .flatMap((f) =>
      readFileSync(join(guardedDir, f), "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*/, "").trim())
        .filter(Boolean),
    );
}

export function validateGuardedSource(
  rel: string,
  src: string,
  enCatalogs: Record<string, number>,
  scanner: {
    findEnglishLiterals: (code: string) => Array<{ line: number; kind: string; text: string }>;
    findAreaKeys: (code: string) => Array<{ line: number; key: string }>;
  },
): GuardIssue[] {
  const issues: GuardIssue[] = [];

  const lit = scanner.findEnglishLiterals(src);
  if (lit.length) {
    issues.push({
      kind: "ENGLISH",
      rel,
      line: lit[0].line,
      message: `${rel} contains ${lit.length} English literal(s): ${JSON.stringify(lit).slice(0, 200)}`,
    });
  }

  for (const k of scanner.findAreaKeys(src)) {
    const key = k.key;
    const ok = enCatalogs[key] || enCatalogs[key + "_one"] || enCatalogs[key + "_other"];
    if (!ok) {
      issues.push({
        kind: "NOKEY",
        rel,
        line: k.line,
        message: `${rel}:${k.line} area key '${key}' not found in English catalogs`,
      });
    }
  }

  return issues;
}

export async function runPrecheck(targetDir = "ui/src") {
  const uiSrc = resolve(targetDir);
  const guardScanUrl = pathToFileURL(join(uiSrc, "i18n/guard-scan.ts")).href;
  const scan = await import(guardScanUrl);

  const guardedDir = join(uiSrc, "i18n/guarded");
  if (!existsSync(guardedDir)) {
    console.error(`::error::Guarded directory not found: ${guardedDir}`);
    return { bad: 1, totalFiles: 0, issues: [] };
  }

  const files = findGuardedFiles(guardedDir);
  const enCatalogs = loadEnCatalogs(uiSrc);

  let bad = 0;
  const allIssues: GuardIssue[] = [];

  for (const rel of files) {
    const p = join(uiSrc, rel);
    if (!existsSync(p)) {
      console.error(`::error file=${p}::MISSING ${rel}`);
      bad++;
      allIssues.push({ kind: "MISSING", rel, message: `MISSING ${rel}` });
      continue;
    }

    const src = readFileSync(p, "utf8");
    const issues = validateGuardedSource(rel, src, enCatalogs, scan);
    if (issues.length) {
      bad += issues.length;
      for (const issue of issues) {
        allIssues.push(issue);
        const lineAttr = issue.line ? `,line=${issue.line}` : "";
        console.error(`::error file=${p}${lineAttr}::${issue.message}`);
      }
    }
  }

  return { bad, totalFiles: files.length, issues: allIssues };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPrecheck(process.argv[2] || "ui/src");
  if (result.bad > 0) {
    console.error(`i18n precheck FAIL: ${result.bad} issue(s) across ${result.totalFiles} guarded file(s).`);
    process.exit(1);
  }
  console.log(`i18n precheck OK: ${result.totalFiles} guarded files scanned, all keys present in English catalogs.`);
  process.exit(0);
}
