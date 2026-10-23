// myrmidon(OPE-8950): the "no English literal in UI" heuristic shared by the
// guard test (legacy-screens-no-english). Pure string scanning, no imports,
// so it can run under plain node as well as vitest.
//
// Catches: JSX text between tags (also across lines), string literals in
// {"..."} / {'...'} JSX children, and string values (either quote, also in
// attr={"..."}) of the user-visible attributes alt, aria-label and the other
// textual aria-*, title, label, placeholder, tooltip, message, intro,
// description, emptyMessage.
//
// Does NOT catch (see docs/myrmidon/ui-i18n-extraction.md): template
// literals, strings built in code, object fields and constants (toast
// texts, option lists, column titles), ternary branches like
// {ok ? "Yes" : "No"}, and text in .ts files. Review those by hand.

export interface GuardOffender {
  line: number;
  kind: "text" | "literal" | "attr";
  text: string;
}

// Textual ARIA attributes. aria-hidden/aria-live/... carry tokens, not text.
const ATTRS =
  "alt|title|label|placeholder|tooltip|message|intro|description|emptyMessage|" +
  "aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|aria-braillelabel";

// Words that may appear as literal JSX text without breaking the RU screen.
const ALLOWED_TEXT = /^(—|-|…|\+|%|\d|\$|\{)/;

/** Blank out comments, keeping line breaks so line numbers stay right. */
export function stripComments(source: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p: string) => p + blank(m.slice(p.length)));
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function looksLikeCode(text: string): boolean {
  if (/^[a-z][A-Za-z0-9_]*$/.test(text)) return true; // single identifier token
  if (/[(){}=;]|=>/.test(text)) return true; // code fragments between angle brackets
  if (/^(Promise|Set|Map|Array|Partial|Pick|React|ReactNode|unknown|void)$/.test(text)) return true;
  if (/[,]|&|\bRecord\b/.test(text)) return true; // type-parameter fragments
  return false;
}

export function findEnglishLiterals(source: string): GuardOffender[] {
  const code = stripComments(source);
  const offenders: GuardOffender[] = [];

  // JSX text children, possibly spanning lines: >Some words<
  for (const match of code.matchAll(/(?<![=-])>([^<>{}]{2,400})</g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    if (!text || ALLOWED_TEXT.test(text)) continue;
    if (!/[A-Za-z]{2}/.test(text)) continue;
    if (looksLikeCode(text)) continue;
    offenders.push({ line: lineOf(code, match.index! + 1), kind: "text", text });
  }

  // String literals as JSX children: {"Text"} / {'Text'} (not attr={"..."})
  for (const match of code.matchAll(/(?<![=\w])\{\s*(["'])((?:(?!\1)[^\\\n])*)\1\s*\}/g)) {
    if (!/\p{L}/u.test(match[2])) continue;
    offenders.push({ line: lineOf(code, match.index!), kind: "literal", text: match[2] });
  }

  // User-visible attributes: attr="..." / attr='...' / attr={"..."} with any letter
  const attrRe = new RegExp(
    `(?<![\\w-])(${ATTRS})=(?:\\{\\s*)?(["'])((?:(?!\\2)[^\\\\\\n])*)\\2`,
    "g",
  );
  for (const match of code.matchAll(attrRe)) {
    if (!/\p{L}/u.test(match[3])) continue;
    offenders.push({ line: lineOf(code, match.index!), kind: "attr", text: `${match[1]}="${match[3]}"` });
  }

  return offenders.sort((a, b) => a.line - b.line);
}

/** Static keys used as t("area....") / i18n.t("area....") in a source file. */
export function findAreaKeys(source: string): Array<{ line: number; key: string }> {
  const code = stripComments(source);
  const keys: Array<{ line: number; key: string }> = [];
  for (const match of code.matchAll(/(?<![\w.])(?:i18n\.)?t\(\s*(["'`])(area\.[^"'`$]+)\1/g)) {
    keys.push({ line: lineOf(code, match.index!), key: match[2] });
  }
  return keys;
}
