// Pre-merge i18n guard on every CI tier (previously a host pre-merge check): run the repo guard scanner
// on every file listed in ui/src/i18n/guarded/*.txt and check area keys exist in the en catalogs.
// usage: node --experimental-strip-types scripts/myrmidon/i18n/precheck.mts <ui/src dir>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const uiSrc = process.argv[2];
const scan = await import(join(uiSrc, "i18n/guard-scan.ts"));
const guardedDir = join(uiSrc, "i18n/guarded");
const files = readdirSync(guardedDir).filter((f) => f.endsWith(".txt") && !f.startsWith("_"))
  .flatMap((f) => readFileSync(join(guardedDir, f), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
const en = {};
const areasDir = join(uiSrc, "i18n/myrmidon-locales/areas");
const flat = (o, p = "") => Object.entries(o).forEach(([k, v]) => (v && typeof v === "object" ? flat(v, p + k + ".") : (en[p + k] = 1)));
for (const f of readdirSync(areasDir).filter((f) => f.endsWith(".en.json"))) flat(JSON.parse(readFileSync(join(areasDir, f), "utf8")));
const base = join(uiSrc, "i18n/myrmidon-locales/en.json");
if (existsSync(base)) flat(JSON.parse(readFileSync(base, "utf8")));
let bad = 0;
for (const rel of files) {
  const p = join(uiSrc, rel);
  if (!existsSync(p)) { console.log(`MISSING ${rel}`); bad++; continue; }
  const src = readFileSync(p, "utf8");
  const lit = scan.findEnglishLiterals(src);
  if (lit.length) { console.log(`ENGLISH ${rel} ${JSON.stringify(lit).slice(0, 200)}`); bad++; }
  for (const k of scan.findAreaKeys(src)) {
    const key = k.key; const ok = en[key] || en[key + "_one"] || en[key + "_other"];
    if (!ok) { console.log(`NOKEY ${rel} ${key}`); bad++; }
  }
}
console.log(bad ? `FAIL ${bad}` : `OK ${files.length} files`);
process.exit(bad ? 1 : 0);
