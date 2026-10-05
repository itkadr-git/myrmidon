// myrmidon(1.7-TG-LOCALE): ratchet — no Russian literals in the Telegram
// bridge code. Every human-readable service text of the bridged DM (commands,
// statuses, refusals, notices) must live in the locale catalogs
// (locales/en.ts, locales/ru.ts) and reach the chat through `t()`; a new
// hardcoded Russian string in the bridge is exactly what this test forbids.
//
// Scope: `server/src/myrmidon/agent-chat-bridge/**` production sources, plus
// the bridge call sites in `server/src/services/chat-channels.ts`. Test files
// are exempt (they assert rendered output in both languages and carry the
// expected strings as fixtures). Non-Cyrillic comments in data modules are
// fine; what counts is a Cyrillic *string literal* (or template fragment) in
// shipped code — comments and docblocks are stripped before the scan, and
// `@гип`-style example tokens inside comments do not trip it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BRIDGE_DIR = join(HERE, "..");
const CHAT_CHANNELS = join(HERE, "..", "..", "services", "chat-channels.ts");
const LOCALES_DIR = join(BRIDGE_DIR, "locales");

const CYRILLIC = /[а-яёА-ЯЁ]/;

/** Strip line and block comments so only code-side strings remain. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...collectTsFiles(path));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (/\.(test|myrmidon\.test)\.ts$/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Extract string literals and template chunks from code (comments already
 * stripped). A crude tokenizer is enough for the ratchet: quotes, backticks
 * (split on `${`), and the Cyrillic check on what they contain.
 */
function stringLiterals(source: string): { value: string; line: number }[] {
  const found: { value: string; line: number }[] = [];
  const pattern = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`|\$\{[^{}]*\}/g;
  for (const match of source.matchAll(pattern)) {
    const raw = match[0];
    const line = source.slice(0, match.index).split("\n").length;
    if (raw.startsWith("`")) {
      // backtick template: every static chunk is a literal candidate
      for (const chunk of raw.slice(1, -1).split(/\$\{[^{}]*\}/)) {
        if (CYRILLIC.test(chunk)) found.push({ value: chunk, line });
      }
      continue;
    }
    if (raw.startsWith("$")) {
      const inner = raw.slice(2, -1);
      if (CYRILLIC.test(inner)) found.push({ value: inner, line });
      continue;
    }
    const inner = raw.slice(1, -1);
    if (CYRILLIC.test(inner)) found.push({ value: inner, line });
  }
  return found;
}

describe("Telegram bridge carries no Russian literals (1.7-TG-LOCALE ratchet)", () => {
  const files = [
    ...collectTsFiles(BRIDGE_DIR).filter((path) => !path.startsWith(LOCALES_DIR)),
    CHAT_CHANNELS,
  ];

  it("scans a non-empty set of bridge sources", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const path of files) {
    const rel = relative(join(HERE, "..", "..", ".."), path);
    it(`${rel} has no Cyrillic string literals`, () => {
      const source = stripComments(readFileSync(path, "utf8"));
      const offenders = stringLiterals(source).map(
        (hit) => `line ${hit.line}: "${hit.value.slice(0, 60)}"`,
      );
      expect(offenders, `expected no Russian literals in ${rel}`).toEqual([]);
    });
  }
});
