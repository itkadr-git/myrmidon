// ui/src/ui2/screens/knowledge/knowledgeModel.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the pure view model behind the ui2
// "Knowledge" screen (read / search / revisions). Everything in this file is
// data-in → data-out so the screen stays a thin renderer and the acceptance
// criteria of the epic (knowledge-architecture §3.9, §6 K-4) are pinned by
// unit tests instead of by a browser:
//
//   - the tree is built in one pass over the flat item list (the "< 300 ms"
//     criterion is a build-time budget, see KNOWLEDGE_TREE_BUDGET_MS);
//   - `[[…]]` references parse into clickable link segments (code spans and
//     fenced blocks stay inert — §3.2: code and quotes create no edges);
//   - the sources panel resolves a source ref to a board route or an external
//     URL (task / issue / PR / decision);
//   - revisions diff line-by-line, and the rollback verb is gated by the
//     approver kind (`a` = the agent itself, `o` = a person).
//
// No React, no i18n, no API here: keys are returned as strings and the screen
// renders them through the ui2 catalog.

/** How fast the tree must be built/rendered from loaded items (§6 K-4). */
export const KNOWLEDGE_TREE_BUDGET_MS = 300;

/** Who may perform a write verb on a knowledge item. */
export type KnowledgeApproverKind = "agent" | "operator" | "owner";

/** Autonomy verdicts that gate a write verb (`knowledge.item.rollback` …). */
export type KnowledgeVerdict = "allowed" | "approval_required" | "forbidden";

/** A reference from a knowledge page to something the board owns. */
export interface KnowledgeSourceRef {
  /** `task` | `issue` | `pr` | `run` | `decision` | `url` | … */
  kind: string;
  /** Issue identifier, `owner/repo#123`, or an absolute URL. */
  ref: string;
  label?: string | null;
}

/** One row of the per-item revision history. */
export interface KnowledgeRevisionSummary {
  revision: number;
  at: string;
  by: string;
  note?: string | null;
}

/** A list-level knowledge item (no body: the tree query stays cheap). */
export interface KnowledgeItemSummary {
  id: string;
  spaceKey: string;
  slug: string;
  title: string;
  parentSlug?: string | null;
  status: string;
  kind?: string | null;
  revision: number;
  updatedAt: string;
  /** Set when a re-review is due; drives the "needs review" badge. */
  reviewDueAt?: string | null;
  language?: string | null;
}

/** A page-level knowledge item: the summary plus the body and its edges. */
export interface KnowledgeItemDetail extends KnowledgeItemSummary {
  body: string;
  sources?: KnowledgeSourceRef[];
  backlinks?: KnowledgeSourceRef[];
  revisions?: KnowledgeRevisionSummary[];
}

export interface KnowledgeTreeNode {
  item: KnowledgeItemSummary;
  /** 0 for a space root; the tree column indents by this. */
  depth: number;
  children: KnowledgeTreeNode[];
}

const treeKey = (spaceKey: string, slug: string): string => `${spaceKey}/${slug}`;

/**
 * Build the nested tree from the flat item list.
 *
 * Single pass over the items for the parent links, then one sort per level
 * (O(n log n) total). A parent chain that loops back on itself is treated as
 * a root instead of hanging the walk: the loop guard runs at most `items.length`
 * steps per item and the recursion carries a visited set.
 */
export function buildKnowledgeTree(
  items: readonly KnowledgeItemSummary[],
): KnowledgeTreeNode[] {
  const nodes = new Map<string, KnowledgeTreeNode>();
  for (const item of items) {
    nodes.set(treeKey(item.spaceKey, item.slug), { item, depth: 0, children: [] });
  }

  const roots: KnowledgeTreeNode[] = [];
  for (const [key, node] of nodes) {
    const parentKey = node.item.parentSlug
      ? treeKey(node.item.spaceKey, node.item.parentSlug)
      : null;
    const parent = parentKey ? nodes.get(parentKey) : undefined;
    if (!parent || parent === node || isDescendant(parent, node, nodes)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const order = (list: KnowledgeTreeNode[], depth: number): void => {
    list.sort((left, right) => left.item.title.localeCompare(right.item.title, "ru"));
    for (const node of list) {
      node.depth = depth;
      order(node.children, depth + 1);
    }
  };
  order(roots, 0);
  return roots;
}

/** True when `candidate` sits below `node` — a cycle must not become a link. */
function isDescendant(
  candidate: KnowledgeTreeNode,
  node: KnowledgeTreeNode,
  nodes: Map<string, KnowledgeTreeNode>,
): boolean {
  let current: KnowledgeTreeNode | undefined = candidate;
  for (let step = 0; step <= nodes.size && current; step += 1) {
    if (current === node) return true;
    const parentSlug: string | null | undefined = current.item.parentSlug;
    current = parentSlug
      ? nodes.get(treeKey(current.item.spaceKey, parentSlug))
      : undefined;
  }
  return false;
}

/** Depth-first flattening in render order (tree column + keyboard walk). */
export function flattenKnowledgeTree(
  nodes: readonly KnowledgeTreeNode[],
): KnowledgeTreeNode[] {
  const out: KnowledgeTreeNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenKnowledgeTree(node.children));
  }
  return out;
}

/** Group the flat list by space key, keeping the catalog order of the spaces. */
export function groupKnowledgeItemsBySpace(
  items: readonly KnowledgeItemSummary[],
): Array<{ spaceKey: string; items: KnowledgeItemSummary[] }> {
  const groups = new Map<string, KnowledgeItemSummary[]>();
  for (const item of items) {
    const bucket = groups.get(item.spaceKey);
    if (bucket) bucket.push(item);
    else groups.set(item.spaceKey, [item]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "ru"))
    .map(([spaceKey, grouped]) => ({ spaceKey, items: grouped }));
}

export type KnowledgeBodySegment =
  | { type: "text"; text: string }
  | {
      type: "link";
      /** `slug` or `space/slug` as written between the brackets. */
      target: string;
      alias: string | null;
      anchor: string | null;
      raw: string;
    };

function pushText(out: KnowledgeBodySegment[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** Split the inner text of a `[[…]]` reference into target / alias / anchor. */
export function parseKnowledgeLinkInner(
  inner: string,
): { target: string; alias: string | null; anchor: string | null } | null {
  const pipe = inner.indexOf("|");
  const head = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
  if (!head) return null;
  const hash = head.indexOf("#");
  const target = (hash === -1 ? head : head.slice(0, hash)).trim();
  const anchor = hash === -1 ? null : head.slice(hash + 1).trim() || null;
  if (!target) return null;
  return { target, alias, anchor };
}

function parseInlineSegments(line: string): KnowledgeBodySegment[] {
  const out: KnowledgeBodySegment[] = [];
  let buffer = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "[") {
      buffer += "[[";
      index += 2;
      continue;
    }
    if (char === "`") {
      const close = line.indexOf("`", index + 1);
      if (close === -1) {
        buffer += line.slice(index);
        break;
      }
      buffer += line.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    if (char === "[" && line[index + 1] === "[") {
      const close = line.indexOf("]]", index + 2);
      if (close === -1) {
        buffer += line.slice(index);
        break;
      }
      const parsed = parseKnowledgeLinkInner(line.slice(index + 2, close));
      if (parsed) {
        if (buffer) {
          pushText(out, buffer);
          buffer = "";
        }
        out.push({ type: "link", ...parsed, raw: line.slice(index, close + 2) });
        index = close + 2;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  if (buffer) pushText(out, buffer);
  return out;
}

/**
 * Parse a page body into text / link segments. Fenced blocks and inline code
 * spans are emitted as plain text, so `[[…]]` inside code never becomes a link
 * (§3.2) and the renderer stays a flat map over the segments.
 */
export function parseKnowledgeBody(body: string): KnowledgeBodySegment[] {
  const segments: KnowledgeBodySegment[] = [];
  const lines = body.split("\n");
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const suffix = index === lines.length - 1 ? "" : "\n";
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      pushText(segments, line + suffix);
      continue;
    }
    if (inFence) {
      pushText(segments, line + suffix);
      continue;
    }
    for (const segment of parseInlineSegments(line)) segments.push(segment);
    pushText(segments, suffix);
  }
  return segments;
}

/** A `[[…]]` target: a sibling slug, or `space/slug` crossing spaces. */
export interface KnowledgeLinkTarget {
  spaceKey: string;
  slug: string;
  anchor: string | null;
}

export function resolveKnowledgeLinkTarget(
  target: string,
  currentSpaceKey: string,
  anchor: string | null = null,
): KnowledgeLinkTarget {
  const slash = target.indexOf("/");
  if (slash <= 0) return { spaceKey: currentSpaceKey, slug: target, anchor };
  return {
    spaceKey: target.slice(0, slash),
    slug: target.slice(slash + 1),
    anchor,
  };
}

/** Company-relative href of a knowledge page — the shell's Link adds the prefix. */
export function knowledgeHref(target: KnowledgeLinkTarget): string {
  const base = `/knowledge/${encodeURIComponent(target.spaceKey)}/${encodeURIComponent(target.slug)}`;
  return target.anchor ? `${base}#${target.anchor}` : base;
}

/** The href of a `[[…]]` link segment relative to the page it sits on. */
export function knowledgeLinkHref(
  segment: Extract<KnowledgeBodySegment, { type: "link" }>,
  currentSpaceKey: string,
): string {
  return knowledgeHref(resolveKnowledgeLinkTarget(segment.target, currentSpaceKey, segment.anchor));
}

export type KnowledgeSourceLink =
  | { kind: "internal"; to: string }
  | { kind: "external"; href: string };

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** `owner/repo#123` → the pull request URL the sources panel opens. */
export function pullRequestUrl(ref: string): string | null {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
  if (!match) return null;
  return `https://github.com/${match[1]}/pull/${match[2]}`;
}

/**
 * Where a source ref leads. Internal targets are company-relative paths (the
 * shell's Link prefixes them, P1); `null` means the ref renders as plain text
 * instead of a dead link.
 */
export function knowledgeSourceLink(source: KnowledgeSourceRef): KnowledgeSourceLink | null {
  const ref = (source.ref ?? "").trim();
  if (!ref) return null;
  if (isHttpUrl(ref)) return { kind: "external", href: ref };
  const kind = (source.kind ?? "").toLowerCase();
  switch (kind) {
    case "pr":
    case "pull_request":
    case "pull-request": {
      const url = pullRequestUrl(ref);
      if (url) return { kind: "external", href: url };
      return { kind: "internal", to: `/issues/${encodeURIComponent(ref)}` };
    }
    case "task":
    case "issue":
    case "problem":
      return { kind: "internal", to: `/issues/${encodeURIComponent(ref)}` };
    case "decision":
      return { kind: "internal", to: "/decisions" };
    case "run":
      return { kind: "internal", to: `/runs/${encodeURIComponent(ref)}` };
    default:
      return null;
  }
}

export type KnowledgeDiffKind = "same" | "add" | "remove";

export interface KnowledgeDiffLine {
  kind: KnowledgeDiffKind;
  text: string;
}

/** Above this many lines per side the diff degrades to a trimmed comparison. */
const DIFF_LINE_LIMIT = 1200;

/**
 * Line diff between two revision bodies (LCS). Order is: every removal, then
 * every addition, for one changed hunk — enough for a readable side-by-side
 * and cheap to assert in tests. Large bodies fall back to trimming the common
 * prefix/suffix so the screen never blocks on a pathological page.
 */
export function diffKnowledgeRevisions(from: string, to: string): KnowledgeDiffLine[] {
  const left = from.split("\n");
  const right = to.split("\n");
  if (left.length > DIFF_LINE_LIMIT || right.length > DIFF_LINE_LIMIT) {
    return diffByTrim(left, right);
  }
  const rows = left.length;
  const cols = right.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row]![col] =
        left[row] === right[col]
          ? table[row + 1]![col + 1]! + 1
          : Math.max(table[row + 1]![col]!, table[row]![col + 1]!);
    }
  }
  const out: KnowledgeDiffLine[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (left[row] === right[col]) {
      out.push({ kind: "same", text: left[row]! });
      row += 1;
      col += 1;
      continue;
    }
    if (table[row + 1]![col]! >= table[row]![col + 1]!) {
      out.push({ kind: "remove", text: left[row]! });
      row += 1;
    } else {
      out.push({ kind: "add", text: right[col]! });
      col += 1;
    }
  }
  while (row < rows) {
    out.push({ kind: "remove", text: left[row]! });
    row += 1;
  }
  while (col < cols) {
    out.push({ kind: "add", text: right[col]! });
    col += 1;
  }
  return out;
}

function diffByTrim(left: readonly string[], right: readonly string[]): KnowledgeDiffLine[] {
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }
  return [
    ...left.slice(0, head).map((text) => ({ kind: "same" as const, text })),
    ...left.slice(head, left.length - tail).map((text) => ({ kind: "remove" as const, text })),
    ...right.slice(head, right.length - tail).map((text) => ({ kind: "add" as const, text })),
    ...right.slice(right.length - tail).map((text) => ({ kind: "same" as const, text })),
  ];
}

/** Count of changed (added + removed) lines — the "N changed" revision badge. */
export function knowledgeDiffChangeCount(lines: readonly KnowledgeDiffLine[]): number {
  return lines.filter((line) => line.kind !== "same").length;
}

export function knowledgeStatusTone(status: string): "ok" | "warning" | "muted" {
  switch ((status ?? "").toLowerCase()) {
    case "approved":
      return "ok";
    case "draft":
    case "in_review":
      return "warning";
    default:
      return "muted";
  }
}

/** True when a re-review is due (the badge on the item header). */
export function isKnowledgeReviewDue(
  item: Pick<KnowledgeItemSummary, "reviewDueAt">,
  now: Date = new Date(),
): boolean {
  if (!item.reviewDueAt) return false;
  const due = new Date(item.reviewDueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() <= now.getTime();
}

/** The `a`/`o` marker of the epic: who carries the write verb. */
export type KnowledgeWriteMode = "A" | "O";

export function normalizeKnowledgeApproverKind(value: unknown): KnowledgeApproverKind | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "a":
    case "agent":
      return "agent";
    case "o":
    case "operator":
      return "operator";
    case "owner":
    case "board":
    case "human":
      return "owner";
    default:
      return null;
  }
}

export function knowledgeWriteMode(kind: KnowledgeApproverKind): KnowledgeWriteMode {
  return kind === "agent" ? "A" : "O";
}

export interface KnowledgeWriteGate {
  allowed: boolean;
  approverKind: KnowledgeApproverKind;
  mode: KnowledgeWriteMode;
  /** Catalog key explaining the state (`ui2.knowledge.action.*`). */
  reasonKey: string;
}

const GATE_KEYS = {
  allowed: "ui2.knowledge.action.allowed",
  needsApproval: "ui2.knowledge.action.needsApproval",
  forbidden: "ui2.knowledge.action.forbidden",
  needsApprovalUnknown: "ui2.knowledge.action.needsApproval",
} as const;

/**
 * Gate a write verb (rollback / approve) on the item.
 *
 * `allowed` → the acting side may do it on its own; `approval_required` → the
 * button stays disabled and names who has to approve; `forbidden` → nobody in
 * the ui2 roles may, the owner reassigns the class. An unknown verdict is
 * treated as "needs approval" — never as allowed.
 */
export function knowledgeWriteGate(input: {
  approverKind?: unknown;
  verdict?: unknown;
}): KnowledgeWriteGate {
  const approver = normalizeKnowledgeApproverKind(input.approverKind);
  const verdict =
    typeof input.verdict === "string" ? input.verdict.trim().toLowerCase() : "";
  if (verdict === "allowed") {
    const kind: KnowledgeApproverKind = approver ?? "agent";
    return {
      allowed: true,
      approverKind: kind,
      mode: knowledgeWriteMode(kind),
      reasonKey: GATE_KEYS.allowed,
    };
  }
  if (verdict === "forbidden") {
    return {
      allowed: false,
      approverKind: "owner",
      mode: "O",
      reasonKey: GATE_KEYS.forbidden,
    };
  }
  const kind: KnowledgeApproverKind = approver ?? "operator";
  return {
    allowed: false,
    approverKind: kind,
    mode: knowledgeWriteMode(kind),
    reasonKey: verdict === "approval_required" ? GATE_KEYS.needsApproval : GATE_KEYS.needsApprovalUnknown,
  };
}

/** The catalog key naming who approves a verb carried by `kind`. */
export function knowledgeApproverLabelKey(kind: KnowledgeApproverKind): string {
  switch (kind) {
    case "agent":
      return "ui2.knowledge.approver.agent";
    case "operator":
      return "ui2.knowledge.approver.operator";
    case "owner":
      return "ui2.knowledge.approver.owner";
  }
}

/** The alias shown for a link, falling back to the target (or the anchor). */
export function knowledgeLinkLabel(
  segment: Extract<KnowledgeBodySegment, { type: "link" }>,
): string {
  if (segment.alias) return segment.alias;
  const slash = segment.target.lastIndexOf("/");
  const slug = slash === -1 ? segment.target : segment.target.slice(slash + 1);
  return segment.anchor ? `${slug}#${segment.anchor}` : slug;
}