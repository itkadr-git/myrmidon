// myrmidon(UI-RU): static guard — the core legacy screens carry no literal
// English JSX text or title/label/placeholder attributes; visible strings run
// through the fork i18n catalog. Codes, identifiers, error messages surfaced
// from the server and data-testid values stay out of scope.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAreaKeys, findEnglishLiterals } from "./guard-scan";
import { collectForkMessages } from "./myrmidon-i18n";
import { flattenCatalog } from "./catalog-utils";

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCREENS = [
  "pages/Issues.tsx",
  "components/IssuesList.tsx",
  "components/IssueColumns.tsx",
  "pages/Agents.tsx",
  "pages/Inbox.tsx",
  "pages/IssueDetail.tsx",
  "pages/Quality.tsx",
  "pages/Quality.production.tsx",
  "pages/Foraging.tsx",
  "pages/SwarmSupervisor.tsx",
  "pages/SwarmSupervisor.production.tsx",
  "pages/SkillLifecycle.tsx",
  "components/myrmidon/skill-lifecycle/SkillLifecyclePanel.tsx",
  "components/myrmidon/budget-limits/BudgetLimitsScreen.tsx",
  "components/myrmidon/budget-limits/BudgetLimitsScreenContainer.tsx",
  "components/access/CompanySettingsNav.tsx",
  "components/Sidebar.tsx",
  "components/myrmidon/MaintenanceBanner.tsx",
];

// myrmidon(OPE-8950): per-area guard lists. Every extraction PR adds its own
// guarded/<area>.txt (one path per line, relative to ui/src; blank lines and
// lines starting with # are ignored), so parallel PRs never touch one file.
const GUARDED_DIR = join(UI_ROOT, "i18n", "guarded");

export function parseGuardedList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

const guardedFromLists = readdirSync(GUARDED_DIR)
  .filter((name) => name.endsWith(".txt"))
  .sort()
  .flatMap((name) => parseGuardedList(readFileSync(join(GUARDED_DIR, name), "utf8")));

const GUARDED = [...new Set(guardedFromLists)];
// A SCREENS file already listed in guarded/*.txt gets the stronger rule only.
const LEGACY_ONLY = SCREENS.filter((rel) => !GUARDED.includes(rel));

// Words that may appear as literal JSX text or attribute values without
// breaking the RU screen: machine tokens and vendor-scope words.
const ALLOWED_TEXT = /^(—|-|…|\+|%|\d|\$|\{)/;

function legacyOffenders(source: string): string[] {
  const lines = source.split("\n");
  const offenders: string[] = [];
  for (const [index, line] of lines.entries()) {
    // strip comments so myrmidon markers do not count
    const code = line.replace(/\/\/.*$/, "");
    if (/^\s*(import|export (type|interface|const|function|type)|\*|\/\*)/.test(code.trim()) && !/<\w/.test(code)) continue;

    // JSX text children like >Some English words<
    for (const match of code.matchAll(/>([^<>{}"'\n]{2,80})</g)) {
      const text = match[1].trim();
      if (!text) continue;
      if (ALLOWED_TEXT.test(text)) continue;
      if (!/[A-Za-z]{2}/.test(text)) continue;
      // single-word camelCase/identifier-looking tokens are code, not UI
      if (/^[a-z][A-Za-z0-9_]*$/.test(text)) continue;
      // code fragments between angle brackets: comparisons, type
      // parameters and call arguments, not JSX text
      if (/[()=?.]/.test(text)) continue;
      // TS type tokens that appear between angle brackets
      if (/^(Promise|Set|Map|Array|Partial|Pick|React|ReactNode|unknown|void)$/.test(text)) continue;
      // type-parameter fragments: commas, intersections, generics
      if (/[,]|&|\bRecord\b/.test(text)) continue;
      offenders.push(`line ${index + 1}: text "${text}"`);
    }
    // user-visible attributes with literal values
    for (const match of code.matchAll(/\b(message|title|placeholder|intro|aria-label|label|description|emptyMessage)="([A-Z][^"]{3,80})"/g)) {
      offenders.push(`line ${index + 1}: attr ${match[1]}="${match[2]}"`);
    }
  }
  return offenders;
}

// SCREENS: the original single-line rule (kept as is; the files are not yet
// extracted under the stronger rule, they belong to areas in guarded/_areas.md
// and move to guarded/<area>.txt when their area is done).
describe("legacy screens carry no English literals", () => {
  for (const rel of LEGACY_ONLY) {
    it(`${rel} has no literal English UI text`, () => {
      const source = readFileSync(join(UI_ROOT, rel), "utf8");
      expect(legacyOffenders(source), `expected no literal English UI text in ${rel}`).toEqual([]);
    });
  }
});

// guarded/*.txt: the stronger rule (multi-line JSX text, {"..."} literals,
// alt/aria/title/label/placeholder/tooltip attributes with any letter).

describe("guarded files carry no English literals", () => {
  it("guarded lists name only .tsx files under ui/src", () => {
    expect(guardedFromLists.filter((rel) => !rel.endsWith(".tsx") || rel.startsWith("/") || rel.includes(".."))).toEqual([]);
  });
  it("catches hard-coded English in a ternary code branch but ignores identifiers and i18n keys", () => {
    expect(findEnglishLiterals('{ready ? "Ready to run" : t("area.jobs.waiting")}')).toEqual([
      { line: 1, kind: "literal", text: "Ready to run" },
    ]);
  });

  it("ignores data and class strings in ternary expressions while catching user-facing copy", () => {
    expect(findEnglishLiterals([
      'const route = allowed ? "access" : "gallery";',
      'const url = local ? "https://local.example" : "https://remote.example";',
      'const classes = active ? "text-sm font-bold" : "text-xs";',
      'const label = ready ? "Ready to run" : "Waiting for approval";',
    ].join("\n"))).toEqual([
      { line: 4, kind: "literal", text: "Ready to run" },
    ]);
  });
  it("scans all shipped and example plugin UI entry files", () => {
    const pluginUiFiles = readdirSync(join(UI_ROOT, "../../packages/plugins"), { recursive: true })
      .filter((path): path is string => typeof path === "string" && /^((examples\/[^/]+)|([^/]+))\/src\/ui\/.*\.tsx?$/.test(path))
      .map((path) => join(UI_ROOT, "../../packages/plugins", path))
      .filter((path) => !path.includes("/sdk/src/ui/"));
    expect(pluginUiFiles.length).toBeGreaterThan(0);
    const expectedLegacyEnglishFiles = new Set([
      "plugin-llm-wiki/src/ui/app.tsx",
      "plugin-workspace-diff/src/ui/index.tsx",
      "examples/plugin-authoring-smoke-example/src/ui/index.tsx",
      "examples/plugin-file-browser-example/src/ui/index.tsx",
      "examples/plugin-hello-world-example/src/ui/index.tsx",
      "examples/plugin-kitchen-sink-example/src/ui/AsciiArtAnimation.tsx",
      "examples/plugin-kitchen-sink-example/src/ui/index.tsx",
      "examples/plugin-orchestration-smoke-example/src/ui/index.tsx",
    ]);
    const offenders = pluginUiFiles.flatMap((path) =>
      findEnglishLiterals(readFileSync(path, "utf8")).map((o) => `${path}:line ${o.line}: ${o.kind} "${o.text}"`),
    );
    const allowlistedOffenders = offenders.filter((item) =>
      [...expectedLegacyEnglishFiles].some((file) => item.includes(`/packages/plugins/${file}:`)),
    );
    expect(
      offenders.filter((item) => !allowlistedOffenders.includes(item)),
      "expected no hard-coded English UI copy outside the explicit legacy allowlist",
    ).toEqual([]);
    expect(allowlistedOffenders.length).toBeGreaterThan(0);
  });

  it("scans web application UI sources when present", () => {
    const webRoot = join(UI_ROOT, "../../web");
    if (!existsSync(webRoot)) return;
    const webFiles = readdirSync(webRoot, { recursive: true })
      .filter((path): path is string => typeof path === "string" && /\.(?:tsx|jsx)$/.test(path))
      .map((path) => join(webRoot, path));
    expect(webFiles.length).toBeGreaterThan(0);
    const offenders = webFiles.flatMap((path) =>
      findEnglishLiterals(readFileSync(path, "utf8")).map((o) => `${path}:line ${o.line}: ${o.kind} "${o.text}"`),
    );
    expect(offenders, "expected no hard-coded English UI copy in web files").toEqual([]);
  });

  it("detects a deliberately untranslated plugin JSX string", () => {
    expect(findEnglishLiterals('<button>Intentionally untranslated</button>')).toEqual([
      { line: 1, kind: "text", text: "Intentionally untranslated" },
    ]);
  });

  it("the scanner skips attribute values that are only a URL or path", () => {
    const found = findEnglishLiterals(
      '<Input placeholder="https://docs.google.com/spreadsheets/d/..." />\n<Input placeholder="wss://mcp.example.com/x" />\n<Input placeholder="/srv/data" />\n<Input placeholder="Paste https://example.com here" />',
    ).map((o) => `${o.kind}:${o.text}`);
    expect(found).toEqual(['attr:placeholder="Paste https://example.com here"']);
  });

  it("the scanner skips ternary code fragments between JSX tags", () => {
    const found = findEnglishLiterals(
      '<div>\n  <p>Ready</p>\n</div>\n    : repair ? repair.canReconnect ? <Step />\n    : <p>Not ready yet</p>',
    ).map((o) => `${o.kind}:${o.text}`);
    expect(found).toEqual(["text:Ready", "text:Not ready yet"]);
  });
  it("the scanner catches multi-line text, {\"...\"} literals and textual attributes", () => {
    const found = findEnglishLiterals(
      '<div>\n  <Button\n    alt="x"\n    aria-label=\'Close it\'\n    data-testid="ok-id1"\n  >\n    Save the\n    changes\n  </Button>\n  {"Hello"}\n  <Foo aria-hidden="true" />\n</div>',
    ).map((o) => `${o.kind}:${o.text}`);
    expect(found).toEqual(['attr:alt="x"', "attr:aria-label=\"Close it\"", "text:Save the changes", "literal:Hello"]);
  });

  for (const rel of GUARDED) {
    it(`${rel} has no literal English UI text`, () => {
      const path = join(UI_ROOT, rel);
      expect(existsSync(path), `guarded file ${rel} does not exist`).toBe(true);
      const offenders = findEnglishLiterals(readFileSync(path, "utf8")).map(
        (o) => `line ${o.line}: ${o.kind} "${o.text}"`,
      );
      expect(offenders, `expected no literal English UI text in ${rel}`).toEqual([]);
    });
  }
});

// Every static t("area.…") / i18n.t("area.…") in guarded files must exist in
// the en catalog (a key may also exist as plural forms key_one/key_other…).
describe("guarded files use only existing area keys", () => {
  const modules = import.meta.glob(["./myrmidon-locales/*.json", "./myrmidon-locales/areas/*.json"], {
    eager: true,
    import: "default",
  }) as Record<string, Record<string, unknown>>;
  const en = flattenCatalog(collectForkMessages(modules).en ?? {});
  const known = (key: string) =>
    en.has(key) || ["_one", "_other", "_few", "_many", "_zero", "_two"].some((suffix) => en.has(key + suffix));

  it("findAreaKeys reads static t() and i18n.t() keys only", () => {
    const keys = findAreaKeys('t("area.a.b"); i18n.t(\'area.c.d\'); t(`area.x.${k}`); t("common.save"); split("area.q")');
    expect(keys.map((k) => k.key)).toEqual(["area.a.b", "area.c.d"]);
  });

  for (const rel of GUARDED) {
    it(`${rel} references existing keys`, () => {
      const missing = findAreaKeys(readFileSync(join(UI_ROOT, rel), "utf8"))
        .filter(({ key }) => !known(key))
        .map(({ line, key }) => `line ${line}: ${key}`);
      expect(missing, `keys missing in the en catalog for ${rel}`).toEqual([]);
    });
  }
});
