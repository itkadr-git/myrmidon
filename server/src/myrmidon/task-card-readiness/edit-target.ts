// myrmidon(TASK-CARD-READINESS-4, OPE-12169): does the place of edit a card
// names actually exist on the default branch of the company's repository?
//
// The card's «МЕСТО ПРАВКИ» section is parsed for repository paths — a token
// with a "/" and a file extension. A token on a line that marks the path as a
// new file («новый файл», «new file») is deliberately NOT checked: a file that
// is about to be created cannot exist yet, and demanding it would block exactly
// the cards that create files.
//
// Every remaining path gets a HEAD request to the raw-content host of the
// default branch of the connected repository. Only "the server says the file is
// not there" (404/410) is a hard violation. Anything that means "I cannot tell"
// — no repository, no GitHub connection, a network failure, a timeout, an auth
// or rate-limit answer, a 5xx — is reported as a warning-violation and the
// transition is allowed: a GitHub outage or an unconfigured company must not
// freeze the board.
//
// Scope: existence only (no content read), no cache (each transition is a live
// check), no UI. The probe is live every time on purpose; caching is a separate
// task.

import { and, eq } from "drizzle-orm";
import { issues, projectWorkspaces, type Db } from "@myrmidon/db";
import { TASK_CARD_VIOLATION_CODES, type TaskCardReadinessViolation } from "@myrmidon/shared";
import { normalizeGitHubRepository } from "../github-shared-identity/settings.js";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "../../services/github-fetch.js";
import { resolveGitHubRepositoryToken } from "../../services/github-external-object-provider.js";

/** Violation codes owned by the edit-target check (declared in the shared contract). */
export const TASK_CARD_EDIT_TARGET_CODES = {
  /** The card names a path the repository does not have on its default branch. */
  EDIT_TARGET_NOT_FOUND: TASK_CARD_VIOLATION_CODES.EDIT_TARGET_NOT_FOUND,
  /** The path could not be checked (no connection, network, auth, timeout). */
  EDIT_TARGET_UNVERIFIED: TASK_CARD_VIOLATION_CODES.EDIT_TARGET_UNVERIFIED,
} as const;

export type TASK_CARD_EDIT_TARGET_CODE =
  (typeof TASK_CARD_EDIT_TARGET_CODES)[keyof typeof TASK_CARD_EDIT_TARGET_CODES];

/**
 * A gate violation (the shared contract, not a local copy). `severity`
 * separates "this blocks the transition" from "this is a warning and the
 * transition is allowed".
 */
export type TaskCardGateViolation = TaskCardReadinessViolation;

/** A repository path named by the card, with the "new file" marker resolved. */
export interface EditTargetPath {
  path: string;
  /** The card marks this path as a file it is about to create. */
  isNew: boolean;
  /** The card line the path was read from, for a readable violation message. */
  line: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Other card sections end «МЕСТО ПРАВКИ»; parsing stops at the first one. */
const SECTION_STOP_MARKERS = [
  "НАМЕРЕНИЕ",
  "ГРАНИЦА ОБЪЁМА",
  "КРИТЕРИИ ПРИЁМКИ",
  "ТЕСТ",
];

const EDIT_TARGET_HEADING = "МЕСТО ПРАВКИ";

/**
 * A path-like token: at least one "/" and a 1-8 char extension on the last
 * segment. Word characters plus the punctuation that shows up in real paths
 * (`-`, `_`, `.`, `@`, `+`).
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

const NEW_FILE_RE = /нов[а-яё]*\s+файл|new\s+files?/iu;

/** Cap on probed paths: a card is a card, not a directory listing. */
export const EDIT_TARGET_MAX_PATHS = 20;

function stripUrls(text: string): string {
  // A URL is not a repository path; drop it before tokenising so
  // raw.githubusercontent.com/owner/repo/main/x.ts never becomes a candidate.
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
}

function isPathLike(token: string): boolean {
  if (!token.includes("/")) return false;
  if (token.includes("//")) return false;
  if (/^[./]/.test(token)) return false; // ./, ../, absolute — not a repository path
  if (/[*?<>{}$|\\]/.test(token)) return false; // globs and placeholders are not paths
  const segments = token.split("/");
  if (segments.some((segment) => segment.length === 0)) return false;
  // A host-shaped first segment ("github.com/owner/x.ts") is a URL, not a path.
  if (segments.length >= 3 && segments[0]!.includes(".")) return false;
  return true;
}

/**
 * Read the «МЕСТО ПРАВКИ» section of a card and return the repository paths it
 * names. Deterministic and network-free: same card, same list, same order.
 */
export function extractEditTargetPaths(description: string | null | undefined): EditTargetPath[] {
  const text = description ?? "";
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.toUpperCase().includes(EDIT_TARGET_HEADING)) {
      start = i;
      break;
    }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const upper = lines[i]!.toUpperCase();
    if (SECTION_STOP_MARKERS.some((marker) => upper.includes(marker))) {
      end = i;
      break;
    }
  }

  const found = new Map<string, EditTargetPath>();
  for (const rawLine of lines.slice(start, end)) {
    const line = stripUrls(rawLine);
    for (const match of line.matchAll(PATH_TOKEN_RE)) {
      const candidate = match[0]!.replace(/\.+$/, "");
      if (!isPathLike(candidate)) continue;
      const isNew = NEW_FILE_RE.test(rawLine);
      const existing = found.get(candidate);
      if (!existing) {
        found.set(candidate, { path: candidate, isNew, line: rawLine.trim() });
      } else if (!isNew) {
        // The same path named twice without the marker is a real edit target.
        existing.isNew = false;
      }
    }
  }
  return [...found.values()];
}

/** What the credential layer answered for the card's repository. */
export type EditTargetCredential =
  | { status: "available"; token: string | null }
  | { status: "absent" | "unavailable"; reason?: string };

export interface VerifyEditTargetsInput {
  paths: EditTargetPath[];
  /** `owner/repo` of the connected repository; null/absent means "unknown". */
  repository?: string | null;
  credentials?: EditTargetCredential;
  /** Default branch of the repository; resolved from GitHub when absent. */
  defaultBranch?: string | null;
  /** github.com or a GitHub Enterprise hostname. */
  hostname?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxPaths?: number;
}

export interface VerifyEditTargetsResult {
  /** Error-severity violations: the card must not pass. */
  violations: TaskCardGateViolation[];
  /** Every violation produced, warnings included. */
  allViolations: TaskCardGateViolation[];
  checked: string[];
  skipped: string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

function warning(message: string, path?: string): TaskCardGateViolation {
  return {
    code: TASK_CARD_EDIT_TARGET_CODES.EDIT_TARGET_UNVERIFIED,
    message,
    severity: "warning",
    ...(path ? { path } : {}),
  };
}

function notFound(path: string): TaskCardGateViolation {
  return {
    code: TASK_CARD_EDIT_TARGET_CODES.EDIT_TARGET_NOT_FOUND,
    message: `Путь «${path}» из раздела «МЕСТО ПРАВКИ» не найден в репозитории на ветке по умолчанию.`,
    severity: "error",
    path,
  };
}

function authHeaders(token?: string | null): HeadersInit {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function signalFor(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return undefined;
  return AbortSignal.timeout(timeoutMs);
}

/** Resolve the default branch of `owner/repo`; null when it cannot be read. */
async function readDefaultBranch(
  repository: string,
  input: { fetchImpl: FetchLike; hostname: string; token?: string | null; timeoutMs: number },
): Promise<string | null> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) return null;
  try {
    const response = await input.fetchImpl(
      `${gitHubApiBase(input.hostname)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: authHeaders(input.token), signal: signalFor(input.timeoutMs) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { default_branch?: unknown };
    return typeof body?.default_branch === "string" && body.default_branch.trim()
      ? body.default_branch.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * HEAD every named path against the default branch of the connected
 * repository. Never throws: inability to check is a warning, not a block.
 */
export async function verifyEditTargets(input: VerifyEditTargetsInput): Promise<VerifyEditTargetsResult> {
  const paths = input.paths.filter((entry) => !entry.isNew);
  const skipped = input.paths.filter((entry) => entry.isNew).map((entry) => entry.path);
  const result: VerifyEditTargetsResult = { violations: [], allViolations: [], checked: [], skipped };
  if (paths.length === 0) return result;

  const repository = normalizeGitHubRepository(input.repository ?? null);
  if (!repository) {
    result.allViolations.push(
      warning(
        "Не удалось проверить существование места правки: у компании нет подключённого GitHub-репозитория для этой задачи. Переход разрешён.",
      ),
    );
    return result;
  }

  if (input.credentials && input.credentials.status !== "available") {
    result.allViolations.push(
      warning(
        `Не удалось проверить существование места правки в «${repository}»: нет доступного GitHub-подключения${
          input.credentials.reason ? ` (${input.credentials.reason})` : ""
        }. Переход разрешён.`,
      ),
    );
    return result;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = input.fetch ?? (ghFetch as FetchLike);
  const hostname = input.hostname ?? "github.com";
  const token = input.credentials?.status === "available" ? input.credentials.token : null;

  const branch =
    input.defaultBranch ?? (await readDefaultBranch(repository, { fetchImpl, hostname, token, timeoutMs }));
  if (!branch) {
    result.allViolations.push(
      warning(
        `Не удалось определить ветку по умолчанию репозитория «${repository}» — существование места правки не проверено. Переход разрешён.`,
      ),
    );
    return result;
  }

  const [owner, repo] = repository.split("/") as [string, string];
  const cap = input.maxPaths ?? EDIT_TARGET_MAX_PATHS;
  for (const entry of paths.slice(0, cap)) {
    const url = resolveRawGitHubUrl(hostname, owner, repo, branch, entry.path);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "HEAD",
        headers: authHeaders(token),
        signal: signalFor(timeoutMs),
      });
    } catch {
      result.allViolations.push(
        warning(
          `Не удалось проверить путь «${entry.path}»: GitHub недоступен. Переход разрешён.`,
          entry.path,
        ),
      );
      continue;
    }

    if (response.ok) {
      result.checked.push(entry.path);
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      const violation = notFound(entry.path);
      result.violations.push(violation);
      result.allViolations.push(violation);
      result.checked.push(entry.path);
      continue;
    }
    // 401/403/429/5xx and anything else: "cannot tell", never "missing".
    result.allViolations.push(
      warning(
        `Не удалось проверить путь «${entry.path}» в «${repository}»: GitHub ответил ${response.status}. Переход разрешён.`,
        entry.path,
      ),
    );
  }
  return result;
}

/**
 * The repository whose default branch the check reads: the one named by the
 * caller, otherwise the issue's own workspace, otherwise the project's primary
 * workspace, otherwise the company's single distinct repository. Several
 * candidates and no primary means "unknown" — the check then warns and lets
 * the transition through rather than guessing a repository.
 */
export async function resolveTaskCardRepository(
  db: Db,
  input: { companyId: string; issueId?: string | null; repository?: string | null },
): Promise<string | null> {
  const explicit = normalizeGitHubRepository(input.repository ?? null);
  if (explicit) return explicit;

  if (input.issueId) {
    const [issue] = await db
      .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    if (issue?.projectWorkspaceId) {
      const [own] = await db
        .select({ repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, issue.projectWorkspaceId),
            eq(projectWorkspaces.companyId, input.companyId),
          ),
        );
      const repository = normalizeGitHubRepository(own?.repoUrl ?? null);
      if (repository) return repository;
    }
    if (issue?.projectId) {
      const rows = await db
        .select({ repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.projectId, issue.projectId),
            eq(projectWorkspaces.companyId, input.companyId),
          ),
        );
      const primary = rows.find((row) => row.isPrimary);
      const repository = normalizeGitHubRepository(primary?.repoUrl ?? null);
      if (repository) return repository;
      const distinct = new Set(
        rows.map((row) => normalizeGitHubRepository(row.repoUrl)).filter((v): v is string => Boolean(v)),
      );
      if (distinct.size === 1) return [...distinct][0]!;
      return null;
    }
  }

  const all = await db
    .select({ repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.companyId, input.companyId));
  const primaries = new Set(
    all
      .filter((row) => row.isPrimary)
      .map((row) => normalizeGitHubRepository(row.repoUrl))
      .filter((v): v is string => Boolean(v)),
  );
  if (primaries.size === 1) return [...primaries][0]!;
  const distinct = new Set(all.map((row) => normalizeGitHubRepository(row.repoUrl)).filter((v): v is string => Boolean(v)));
  return distinct.size === 1 ? [...distinct][0]! : null;
}

/**
 * Resolve a token for probing the company's repository via the standard
 * secret and shared App paths. Never throws: missing identity or lookup
 * errors return absent/unavailable credentials so verifyEditTargets can fail open.
 */
export async function resolveTaskCardCredentials(
  db: Db,
  input: { companyId: string; repository: string; fetchImpl?: FetchLike },
): Promise<EditTargetCredential> {
  try {
    const token = await resolveGitHubRepositoryToken(
      db,
      input.companyId,
      input.repository,
      undefined,
      input.fetchImpl,
    );
    return { status: "available", token };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "GitHub token lookup failed";
    return { status: "unavailable", reason };
  }
}
