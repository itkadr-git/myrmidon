#!/usr/bin/env node
// DEBRAND 1.6.6 (OPE-8127): release audit of the old brand in user-facing
// documentation and operator-facing repo surfaces.
//
// This is the whole-repo counterpart of docs-branding-guard.mjs: it reports
// EVERY non-allowlisted "Paperclip" mention in the tracked files a release
// ships (root README/CONTRIBUTING/ROADMAP/DESIGN/AGENTS/CLAUDE, docs/**),
// instead of silently passing while a whole document still speaks for the
// vendor product. It is designed as a REPORT first (`node` with no args):
// the count and paths it prints go into the release report verbatim; the
// repo-wide total MAY be non-zero until the parallel DEBRAND parts land.
// Use `--gate` to fail (exit 1) on any finding — CI for this gate runs the
// fixture tests (docs-branding-audit.test.mjs); wiring --gate into a release
// workflow is a maintainer commit (run token has no workflow scope).
//
// The allowlist is EXACT, not globbed: every entry is a full string that is
// cut out of the line before the product-name check, with a category. Bare
// "Paperclip" prose that is not covered fails. A glob like `docs/x/**` can
// never mask a finding, because allowlist entries are applied per line, not
// per file.
//
// Usage:
//   node scripts/myrmidon/brand-release-audit.mjs           # report, exit 0
//   node scripts/myrmidon/brand-release-audit.mjs --gate    # fail on findings
//
// License/legal attribution (LICENSE, NOTICE, "Copyright (c) 2025 Paperclip
// AI", "Based on Paperclip (MIT)") is NEVER scanned for removal and NEVER a
// finding; it is out of scope by definition of the DEBRAND epic.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gate = process.argv.includes("--gate");

// Root files a release ships that the docs-branding guard (docs/ only) did
// not cover. Kept as an explicit list, not a glob, so adding a stray root
// doc is a visible decision.
const ROOT_FILES = [
  "README.md",
  "README.ru.md",
  "CONTRIBUTING.md",
  "ROADMAP.md",
  "DESIGN.md",
  "AGENTS.md",
  "CLAUDE.md",
];

// Category -> exact substrings that keep a line compliant. Mirrors
// docs-branding-guard.mjs; the categories also print in the report so a
// reviewer sees WHY a kept line is kept.
const ALLOWLIST = {
  "vendor repo/package/CLI identifiers": [
    "paperclipai", // @paperclipai/*, the paperclipai CLI, github.com/paperclipai
    "PAPERCLIP_", // env vars
    "X-Paperclip-", // HTTP headers
  ],
  "legal attribution": [
    "Copyright (c) 2025 Paperclip",
    "Based on Paperclip",
    "Paperclip AI", // vendor company name in license/provenance lines
    "Paperclip (MIT)",
  ],
  "compatibility identifiers (owning epic renames first)": [
    "paperclip-server", "paperclip-db", "paperclip-fleetd", "paperclip-local",
    "paperclip-ecs", "paperclip-alb", "paperclip-rds", "paperclip-efs",
    "paperclip.service", ".paperclip", "docker-paperclip", "paperclip-ext/{environment}",
    "skills/paperclip", "paperclip/SKILL", "paperclip/instances",
    "git-credential-paperclip", "paperclip-assigned", "paperclip_runner",
    "buildPaperclipEnv", "buildPaperclipWakePayload", "sanitizeInheritedPaperclipEnv",
    "paperclipTaskMarkdown", "_paperclipGuardrails", "hindsight-paperclip",
    "paperclip-plugin-telegram", "paperclip-plugin-fake-sandbox",
    "paperclip-plugin-hindsight", "paperclip-claude-auth",
    "droid-paperclip-adapter", "my-paperclip-adapter", "paperclip-create-agent",
    "paperclip-operations", "openclaw-paperclip-smoke", "paperclip-self-read",
    "--paperclip-url", "--require-paperclip", "paperclip-run-",
    "paperclip-dev", "paperclip-fork", "paperclip-local-lab",
    "paperclip-runnerd", "paperclip.adapterUiParser", "paperclip.manifest.json",
    "paperclip-telemetry", "paperclip-version", "paperclipValue",
    "lastPaperclipFingerprint", "paperclipUrl", "originSide=paperclip",
    "MYRMIDON_BASE_PAPERCLIP", "basePaperclipVersion", "PaperclipLockup",
    "PaperclipLoading", "AnimatedPaperclipIcon", "PaperclipIcon",
    "`paperclip`", '"paperclip"', "'paperclip'", "paperclip:2026.",
    "the `paperclip` skill", "bare `\\bPaperclip\\b`", "the Paperclip API",
    "\"Paperclip …\"",
    "paperclipVersionMin", "stack-registry", "/paperclip", "paperclip/prod",
    "<paperclip-secret-id>",
  ],
  "external vendor services (not our product)": [
    "Paperclip Cloud", "Paperclip Labs", "Paperclip EE", "Paperclip Enterprise",
    "Paperclip Runner",
  ],
  "historical records (state correct at the time)": [
    "Paperclip 2026.916.1", "Paperclip v2026.916.1", "Paperclip v2026.1001.0",
    "Paperclip → Myrmidon", "from Paperclip to Myrmidon",
    "с Paperclip на Myrmidon", "Migration from Paperclip",
    "Миграция с Paperclip", "Migration-from-Paperclip",
    "migration-from-paperclip",
  ],
  "provenance prose (fork relationship statements)": [
    "на основе Paperclip", "Основан на Paperclip", "основан на Paperclip",
    "Отношение к Paperclip", "Имя Paperclip в коде",
    "Myrmidon от Paperclip", "отличий Myrmidon от Paperclip",
    "вместо Paperclip", "остаётся Paperclip", "Paperclip — только основа",
    "пользователей Paperclip", "Paperclip base", "Paperclip в основе",
    "основы Paperclip", "Base Paperclip version", "base Paperclip version",
    "базового Paperclip", "База:** Paperclip `v2026.916.1`", "Paperclip (MIT)»",
    "Paperclip, взятого", "vendor name **Paperclip**", "Paperclip не отправляем", "бренд везде paperclip!", "БД Paperclip в бэкап-контуре", "тикеты Paperclip", "БД Paperclip", "Paperclip: sign-up выключен", "Paperclip в бэкап-контуре", "тикеты в Paperclip", "Имя вендора **Paperclip**", "«Paperclip»", "[Paperclip](https://github.com/paperclipai/paperclip)",
    "атрибуция MIT «основано на Paperclip» остаётся", "идентификаторы и переменные PAPERCLIP_ не трогаем", "копирайта вендора (Paperclip)",
    "(лицензия MIT\nсохранена", "The Paperclip name remains",
    "Имя\nPaperclip остаётся", "Paperclip остаётся в именах пакетов",
    "рутине Paperclip", "рутина Paperclip", "vendor-product-word exceptions (Cloud", "stays Paperclip",
    "Paperclip-managed", "управляемые навыки Paperclip",
    "Paperclip-managed skills", "Paperclip skill", "Навык Paperclip",
    "Allow Paperclip reads", "upstream Paperclip", "вендорского Paperclip",
    "Paperclip вендора", "Paperclip server", "сервер Paperclip",
    "Paperclip instance", "экземпляр Paperclip", "Paperclip release",
    "Paperclip releases", "Paperclip state", "состояние Paperclip",
    "old Paperclip", "старый Paperclip", "Paperclip features",
    "Paperclip feature", "релизов Paperclip", "релизы Paperclip",
    "релиз Paperclip", "возможностей Paperclip", "Возможности Paperclip",
    "Релизы Paperclip", "экземпляра Paperclip", "форк Paperclip",
    "fork of\n[Paperclip]", "independent product maintained as a fork of",
    "endorsed by", "не одобрен", "не связан",
    "`Paperclip`", '"Paperclip"', "«Paperclip ",
    "vendor Paperclip endpoint", // telemetry goes to the vendor's service
    "vendor-product-word exceptions", "bare `\\bPaperclip\\b`", "old recovery body",
    "«Paperclip needs a disposition", "\"Paperclip needs a disposition", "старое «Paperclip …»", "«Paperclip …»",
    "новое «Myrmidon …»", "MCP-серверов «Paperclip", "«Close the current Paperclip",
    "«Paperclip connected»", "requires a Paperclip", // CLAUDE.md fork pointer
    "его отношение к Paperclip",
    "«Paperclip»", "[Paperclip](https://github.com/paperclipai/paperclip)",
    "(лицензия MIT\nсохранена", "The Paperclip name remains",
    "Имя\nPaperclip остаётся", "Paperclip остаётся в именах пакетов",
    "рутине Paperclip", "рутина Paperclip", "vendor-product-word exceptions (Cloud",
  ],
};

// A bare product-name mention. Word boundaries exclude @paperclipai,
// paperclipai, PAPERCLIP_*, hyphenated and slashed identifiers.
const PRODUCT_NAME = /(?<![\w@./-])Paperclip(?![\w-])/;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing docs/ in a fixture tree: nothing to scan
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".md")) yield p;
  }
}

const targets = [
  ...ROOT_FILES.map((f) => path.join(repoRoot, f)).filter((p) => fs.existsSync(p)),
  ...walk(path.join(repoRoot, "docs")),
];

const findings = [];
for (const file of targets) {
  const rel = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!PRODUCT_NAME.test(line)) return;
    // Strip markdown links whose text is the vendor product name and whose
    // target is the vendor repo — an attribution link, wherever it appears.
    let rest = line.replace(/\[Paperclip\]\(https:\/\/github\.com\/paperclipai\/paperclip[^)]*\)/g, "");
    for (const entries of Object.values(ALLOWLIST)) {
      for (const kept of entries) rest = rest.split(kept).join("");
    }
    if (PRODUCT_NAME.test(rest)) {
      findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
}

console.log(`brand-release-audit: ${findings.length} non-allowlisted "Paperclip" mention(s) in user-facing docs`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}: ${f.text}`);
}
if (findings.length > 0) {
  console.log("brand-release-audit: report mode — findings listed above (a non-zero total is expected until the parallel DEBRAND parts land)");
  if (gate) {
    console.log("brand-release-audit: --gate: failing");
    process.exit(1);
  }
} else {
  console.log("brand-release-audit: clean");
}
