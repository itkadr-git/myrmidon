// server/src/myrmidon/knowledge/migrate/frontmatter.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): plugin wiki pages may carry a YAML
// frontmatter block. The K-6 acceptance criterion requires every migrated page
// to have a *parsed* frontmatter, so the migration parses it here —
// deterministically, with no dependency and no dialect SQL.
//
// Values never leave the process: the migration report records only the key
// names that were parsed (page bodies can hold personal data, §5.3).

export interface ParsedFrontmatter {
  /** True when the file starts with a `---` block (even an empty one). */
  hasFrontmatter: boolean;
  /** Parsed key/value pairs in file order (later duplicates win). */
  data: Record<string, unknown>;
  /** Keys in order of first appearance. */
  keys: string[];
  /** Lines that could not be parsed (counted, never reprinted with values). */
  malformedLines: number;
  /** The markdown body: everything after the closing delimiter. */
  body: string;
}

const OPEN_RE = /^---[ \t]*$/;
const CLOSE_RE = /^(---|\.\.\.)[ \t]*$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
    }
  }
  return trimmed;
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((part) => unquote(part))
      .filter((part) => part.length > 0);
  }
  return unquote(trimmed);
}

/**
 * Parses the leading `---` block of a page. A page without the block is legal:
 * `hasFrontmatter: false` and the whole text is the body. Malformed lines are
 * counted, not thrown: the migration reports them and lets the operator fix
 * the page instead of failing the whole run.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !OPEN_RE.test(lines[0] ?? "")) {
    return { hasFrontmatter: false, data: {}, keys: [], malformedLines: 0, body: raw };
  }

  let index = 1;
  let malformedLines = 0;
  const data: Record<string, unknown> = {};
  const keys: string[] = [];
  let currentListKey: string | null = null;
  let closed = false;

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (CLOSE_RE.test(line)) {
      closed = true;
      index += 1;
      break;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem !== null && currentListKey !== null) {
      const existing = data[currentListKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(scalar(listItem[1] ?? ""));
      data[currentListKey] = list;
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (pair === null) {
      malformedLines += 1;
      continue;
    }
    const key = pair[1]!;
    const value = (pair[2] ?? "").trim();
    if (!keys.includes(key)) keys.push(key);
    if (value === "") {
      // Either an empty scalar or the head of a block list; the next `- item`
      // lines decide. Start from an empty list so a dangling key stays empty.
      data[key] = Array.isArray(data[key]) ? data[key] : [];
      currentListKey = key;
      continue;
    }
    data[key] = scalar(value);
    currentListKey = null;
  }

  const body = closed ? lines.slice(index).join("\n") : lines.slice(1).join("\n");
  return { hasFrontmatter: true, data, keys, malformedLines, body };
}

/** Reads the first markdown H1 as the page title fallback. */
export function extractHeading(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match !== null) return match[1]!;
  }
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found !== null) return found;
    }
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => firstString(entry))
      .filter((entry): entry is string => entry !== null);
  }
  return [];
}

/** The knowledge fields a parsed frontmatter can supply (values, not keys). */
export interface FrontmatterFields {
  title: string | null;
  summary: string | null;
  tags: string[];
  /** Free-form source references declared by the page. */
  sources: string[];
}

/**
 * Maps the key names the plugin pages use onto the knowledge fields. Unknown
 * keys are ignored here but still reported by key name, so the operator sees
 * what the parser found without reading the page.
 */
export function mapFrontmatter(data: Record<string, unknown>): FrontmatterFields {
  return {
    title: firstString(data["title"] ?? data["name"] ?? null),
    summary: firstString(data["summary"] ?? data["description"] ?? data["excerpt"] ?? null),
    tags: stringList(data["tags"] ?? data["keywords"] ?? null),
    sources: stringList(data["sources"] ?? data["source_refs"] ?? data["sourceRefs"] ?? null),
  };
}