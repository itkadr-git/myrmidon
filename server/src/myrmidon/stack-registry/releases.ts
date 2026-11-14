// Stack registry (SUA, part B): the external release-source port and the pure
// helpers of the release check. Public GitHub REST with a bounded timeout:
// anonymous by default; an optional read-only token (MYRMIDON_STACK_GITHUB_TOKEN,
// see settings.ts) rides as a Bearer header on every request when set. No
// internal addresses either way.
//
// Error contract: a transport failure (no network, DNS, timeout) is thrown and
// surfaces as a probe error the route turns into 503 with the previous cache
// intact. An HTTP error status is ordinary data: one repository gone or rate
// limited is a per-component "unknown with a reason", never "the network is
// down". See docs/myrmidon/SETTINGS.md.

import { STACK_NOTE_LINE_LIMIT, STACK_NOTE_LINE_MAX } from "./domain.js";
import type { StackReleaseNotes } from "./domain.js";

export const STACK_GITHUB_API_BASE = "https://api.github.com";
export const STACK_HTTP_TIMEOUT_MS = 10_000;

export interface StackHttpResponse {
  status: number;
  json: unknown;
}

/** A JSON GET or POST. Throws on transport failure; returns any HTTP status as data. */
export interface StackFetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export type StackFetchJson = (url: string, options?: StackFetchOptions) => Promise<StackHttpResponse>;

export function githubJsonPort(
  options: { timeoutMs?: number; token?: string; fetchImpl?: typeof fetch } = {},
): StackFetchJson {
  const timeoutMs = options.timeoutMs ?? STACK_HTTP_TIMEOUT_MS;
  const token = options.token?.trim() || null;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  return async (url, fetchOptions) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "myrmidon-stack-registry",
        ...(fetchOptions?.headers ?? {}),
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchFn(url, {
        method: fetchOptions?.method ?? (fetchOptions?.body ? "POST" : "GET"),
        headers,
        body: fetchOptions?.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function githubListUrl(repo: string, source: "github-releases" | "github-tags", perPage: number): string {
  const kind = source === "github-tags" ? "tags" : "releases";
  return `${STACK_GITHUB_API_BASE}/repos/${repo}/${kind}?per_page=${perPage}`;
}

export function githubCompareUrl(repo: string, base: string, head: string): string {
  const encodeRef = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
  return `${STACK_GITHUB_API_BASE}/repos/${repo}/compare/${encodeRef(base)}...${encodeRef(head)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StackReleaseRecord {
  tag: string;
  publishedAt: string | null;
  body: string | null;
}

function tagPublishedAt(entry: Record<string, unknown>): string | null {
  const commit = entry.commit;
  if (!isRecord(commit)) return null;
  const committer = commit.committer;
  if (!isRecord(committer)) return null;
  return typeof committer.date === "string" ? committer.date : null;
}

/**
 * Read the list payload into ordered release records (newest first, as the API
 * returns them). Unknown shapes are skipped, never fatal.
 */
export function readReleaseList(source: "github-releases" | "github-tags", json: unknown): StackReleaseRecord[] {
  if (!Array.isArray(json)) return [];
  const records: StackReleaseRecord[] = [];
  for (const entry of json) {
    if (!isRecord(entry)) continue;
    const tag = source === "github-tags" ? entry.name : entry.tag_name;
    if (typeof tag !== "string" || tag.length === 0) continue;
    const publishedAt = source === "github-tags"
      ? tagPublishedAt(entry)
      : (typeof entry.published_at === "string" ? entry.published_at : null);
    records.push({
      tag,
      publishedAt,
      body: typeof entry.body === "string" ? entry.body : null,
    });
  }
  return records;
}

const NOTABLE_LINE = /security|vulnerab|CVE-\d{4}-\d+|breaking|deprecat|insecure|exploit/i;
const SECURITY_LINE = /security|vulnerab|CVE-\d{4}-\d+|insecure|exploit/i;

/** Trim a line and cap its length so one release note cannot fill the card. */
function shorten(line: string, max: number): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}\u2026` : collapsed;
}

/**
 * Notable release-note lines (security/breaking/CVE markers), newest releases
 * first, top-N, each line bounded. Null when there is nothing notable.
 */
export function extractReleaseNotes(
  releases: readonly StackReleaseRecord[],
  options: { limit?: number; lineMax?: number; localVersion?: string | null } = {},
): StackReleaseNotes | null {
  const limit = options.limit ?? STACK_NOTE_LINE_LIMIT;
  const lineMax = options.lineMax ?? STACK_NOTE_LINE_MAX;
  const lines: string[] = [];
  let truncated = false;
  let hasSecurity = false;

  // Security notes should only flag security when the note is in
  // upstream.latest or in releases newer than the running local version. The
  // range is decided by version comparison, not feed position: the fetched
  // window is bounded (per_page releases), so a local version older than the
  // window is absent from the list yet still behind — a position lookup would
  // classify it as unknown and skip the security releases between it and
  // upstream.latest.
  const ours = normaliseVersion(options.localVersion ?? null);
  const relevantForSecurity = new Set<string>();
  if (releases.length > 0) {
    // Newest entry by version comparison; null when some tag carries no
    // comparable version (a moving tag, a hash) — fall back to feed order,
    // which the API returns newest-first.
    const latestIndex = findMaxTagIndex(releases);
    const latestTag = latestIndex != null ? releases[latestIndex].tag : releases[0].tag;
    const behind = compareVersionTags(latestTag, ours);
    if (behind == null || behind <= 0) {
      // Unknown local version, or already running the newest release the feed
      // offers (or something newer): only upstream.latest counts.
      relevantForSecurity.add(releases[0].tag);
    } else {
      // Local version is behind: every release strictly newer than it is in range.
      for (const release of releases) {
        const newer = compareVersionTags(release.tag, ours);
        if (newer != null && newer > 0) relevantForSecurity.add(release.tag);
      }
    }
  }

  for (const release of releases) {
    if (!release.body) continue;
    for (const rawLine of release.body.split(/\r?\n/)) {
      if (rawLine.includes("|")) continue; // markdown table rows carry the whole row
      if (!NOTABLE_LINE.test(rawLine)) continue;
      if (SECURITY_LINE.test(rawLine) && relevantForSecurity.has(release.tag)) {
        hasSecurity = true;
      }
      if (lines.length >= limit) {
        truncated = true;
        continue;
      }
      lines.push(`${release.tag} — ${shorten(rawLine, lineMax)}`);
    }
  }
  if (lines.length === 0 && !hasSecurity) return null;
  return { lines, truncated, hasSecurity };
}

/**
 * Whether a known fix commit is part of the compare range. GitHub's compare
 * payload lists the commits of `base...head`; an eight-character prefix match is
 * enough for the neutral short hashes we store.
 */
export function compareContainsFix(json: unknown, fixCommits: readonly string[]): boolean {
  if (!isRecord(json) || !Array.isArray(json.commits)) return false;
  const shas = json.commits
    .filter((c): c is Record<string, unknown> => isRecord(c))
    .map((c) => (typeof c.sha === "string" ? c.sha : ""));
  return fixCommits.some((fix) => {
    const prefix = fix.slice(0, 8).toLowerCase();
    return shas.some((sha) => sha.toLowerCase().startsWith(prefix) || prefix.startsWith(sha.toLowerCase().slice(0, 8)));
  });
}

/** Normalise a local version string (image repoTag, tag, or plain version). */
export function normaliseVersion(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const afterColon = trimmed.slice(trimmed.lastIndexOf(":") + 1);
  const candidate = afterColon.includes("/") ? trimmed : afterColon;
  return candidate.replace(/^v(?=\d)/i, "").toLowerCase();
}

/** True for pre-release / nightly / rc tags that must not count as "latest". */
export function isPrereleaseTag(tag: string): boolean {
  return /(?:^|[-.])(nightly|alpha|beta|rc|pre|dev|snapshot|canary)(?:[-.]|\d|$)/i.test(tag);
}

/**
 * Compare two version tags: negative when `left` is older, positive when
 * newer, 0 when equal. Null when either side carries no comparable core
 * version (a moving tag, a bare hash) — callers must fall back to feed order
 * instead of guessing. Numeric parts compare numerically ("2.10.0" > "2.9.0"),
 * alphanumeric suffixes lexically ("3.2.0-beta" < "3.2.0").
 */
export function compareVersionTags(left: string | null, right: string | null): number | null {
  const a = parseComparableVersion(left);
  const b = parseComparableVersion(right);
  if (!a || !b) return null;
  const width = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < width; i++) {
    const av = a.numbers[i] ?? 0;
    const bv = b.numbers[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  // Suffixes: "3.2.0" (empty) is newer than "3.2.0-beta".
  if (a.suffix !== b.suffix) {
    if (!a.suffix) return 1;
    if (!b.suffix) return -1;
    return a.suffix < b.suffix ? -1 : 1;
  }
  return 0;
}

/** A tag is comparable when it carries a numeric core version ("3.2.0-rc1"). */
function parseComparableVersion(value: string | null): { numbers: number[]; suffix: string } | null {
  const normalised = normaliseVersion(value);
  if (!normalised) return null;
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(normalised);
  if (!m) return null;
  return { numbers: m[1]!.split(".").map((part) => Number(part) || 0), suffix: m[2]! };
}

/**
 * Index of the newest comparable tag in an ordered release list, or null when
 * no tag carries a comparable core version. Ties keep the earliest entry.
 */
export function findMaxTagIndex(releases: readonly StackReleaseRecord[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < releases.length; i++) {
    const tag = releases[i]?.tag ?? null;
    if (!parseComparableVersion(tag)) continue;
    if (best == null || (compareVersionTags(tag, releases[best]!.tag) ?? 0) > 0) {
      best = i;
    }
  }
  return best;
}

/** True for pre-release / nightly / rc tags that must not count as "latest". */
export function isPrereleaseTag(tag: string): boolean {
  return /(?:^|[-.])(nightly|alpha|beta|rc|pre|dev|snapshot|canary)(?:[-.]|\d|$)/i.test(tag);
}

/**
 * Releases/tags between our version and the newest entry, or null when our
 * version is unknown or absent from the ordered list (an honest unknown: we
 * cannot prove the local version is part of this feed). Pre-release and
 * nightly tags never count as the latest release.
 */
export function countBehind(
  releases: readonly StackReleaseRecord[],
  localVersion: string | null,
): { latest: string | null; behindBy: number | null } {
  const stable = releases.filter((release) => !isPrereleaseTag(release.tag));
  const latest = stable[0]?.tag ?? null;
  const ours = normaliseVersion(localVersion);
  if (!ours) return { latest, behindBy: null };
  const normalised = stable.map((release) => normaliseVersion(release.tag));
  const index = normalised.indexOf(ours);
  if (index < 0) return { latest, behindBy: null };
  return { latest, behindBy: index };
}