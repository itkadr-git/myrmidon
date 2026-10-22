// server/src/myrmidon/knowledge/git-export.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-8): the nightly git export of the knowledge
// tree. The database stays the source of truth; this is the second copy
// (architecture §6.3 L-8, R11, I-8) and the copy a person can read.
//
// Determinism: pages are sorted by slug, one file per page under a path
// derived only from the slug, frontmatter keys in a fixed order, and the
// commit message names the content hash, never the clock. A second pass
// over an unchanged tree produces zero commits.
//
// I-7: a page whose folder or slug sits under `directions/life` (or is the
// segment `life`) is left out of the tree. Life knowledge does not leave
// the board through this export.

import { createHash } from "node:crypto";
import type { KnowledgeTreeDoc, KnowledgeTreePage } from "./domain.js";

/** Branch the export is committed onto when the remote has no other ref. */
export const KNOWLEDGE_EXPORT_DEFAULT_BRANCH = "knowledge-export";

/** Git identity of the exporter. Not a person and not an agent. */
export const KNOWLEDGE_EXPORT_AUTHOR_NAME = "myrmidon-knowledge-export";
export const KNOWLEDGE_EXPORT_AUTHOR_EMAIL = "knowledge-export@myrmidon.invalid";

const LIFE_SEGMENT = "life";
const LIFE_PREFIX = "directions/life";

/** True when the page belongs to the private life contour and must not be exported (I-7). */
export function isLifeKnowledgePath(folder: string, slug: string): boolean {
  const parts = `${folder}/${slug}`
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (parts.includes(LIFE_SEGMENT)) return true;
  const joined = parts.join("/");
  return joined === LIFE_PREFIX || joined.startsWith(`${LIFE_PREFIX}/`);
}

/** Pages a person may read: everything except the life contour, in slug order. */
export function pagesForGitExport(doc: KnowledgeTreeDoc): KnowledgeTreePage[] {
  return doc.pages
    .filter((page) => !isLifeKnowledgePath(page.folder, page.slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * One markdown file a person can open. Frontmatter key order is fixed so
 * two exports of the same page are byte-identical.
 */
export function renderKnowledgePageMarkdown(page: KnowledgeTreePage): string {
  const lines = [
    "---",
    `slug: ${yamlString(page.slug)}`,
    `kind: ${yamlString(page.kind)}`,
    `title: ${yamlString(page.title)}`,
    `summary: ${page.summary === null ? "null" : yamlString(page.summary)}`,
    `folder: ${yamlString(page.folder)}`,
    `tags: ${JSON.stringify([...page.tags])}`,
    `status: ${yamlString(page.status)}`,
    `approval_required: ${page.approvalRequired ? "true" : "false"}`,
    `approver_kind: ${page.approverKind === null ? "null" : yamlString(page.approverKind)}`,
    "---",
    "",
    page.content.endsWith("\n") || page.content.length === 0 ? page.content : `${page.content}\n`,
  ];
  return lines.join("\n");
}

/** Repo-relative path of a page. The slug is the path; `.md` is added once. */
export function knowledgePageRepoPath(slug: string): string {
  const clean = slug.replace(/^\/+|\/+$/g, "");
  const file = clean.endsWith(".md") ? clean : `${clean}.md`;
  // The generated README.md is the repository's own file; a page must not take its place.
  return file.toLowerCase() === "readme.md" ? "README-page.md" : file;
}

export interface KnowledgeGitFile {
  /** Path relative to the repository root, posix, no leading slash. */
  path: string;
  content: string;
}

export interface KnowledgeGitTree {
  files: KnowledgeGitFile[];
  /** sha256 of the sorted path+content list. Stable across runs. */
  contentHash: string;
  pageCount: number;
  /** How many pages the life rule removed. */
  excludedLifePages: number;
}

/**
 * The whole repository content for one nest. `README.md` is generated, so
 * a human opening the repo sees what this tree is. Nothing else is written:
 * a file that disappears from the tree is deleted on the next commit.
 */
export function buildKnowledgeGitTree(doc: KnowledgeTreeDoc): KnowledgeGitTree {
  const pages = pagesForGitExport(doc);
  const excludedLifePages = doc.pages.length - pages.length;
  const files: KnowledgeGitFile[] = pages.map((page) => ({
    path: knowledgePageRepoPath(page.slug),
    content: renderKnowledgePageMarkdown(page),
  }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  hash.update(doc.nestId);
  hash.update("\0");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  const contentHash = hash.digest("hex");

  // README is derived from the hash, so it is not hashed itself — otherwise
  // the file that names the hash would change the hash.
  const readme = [
    "# Knowledge export",
    "",
    "Second copy of the knowledge module (KNOWLEDGE-2.0 L-8).",
    "The board database is the source of truth; this tree is rebuilt nightly",
    "and is deterministic: the same pages always produce the same bytes.",
    "",
    "The private life contour is not included.",
    "",
    `nest: ${doc.nestId}`,
    `pages: ${pages.length}`,
    `content: ${contentHash}`,
    "",
  ].join("\n");
  files.unshift({ path: "README.md", content: readme });

  return { files, contentHash, pageCount: pages.length, excludedLifePages };
}

/** Commit subject. The hash is the only variable part, so message is deterministic. */
export function knowledgeExportCommitMessage(tree: KnowledgeGitTree): string {
  return `myrmidon(KNOWLEDGE-2.0 L-8): export ${tree.pageCount} pages ${tree.contentHash.slice(0, 12)}`;
}

/**
 * Where the nightly job pushes. Empty repo URL means the job is off —
 * the same "unset is off" switch the other nightly jobs use. The branch
 * defaults to `knowledge-export`.
 */
export interface KnowledgeExportSettings {
  enabled: boolean;
  repoUrl: string | null;
  branch: string;
  /** Hours between passes. Default 24. */
  intervalHours: number;
}

export const KNOWLEDGE_EXPORT_REPO_ENV = "MYRMIDON_KNOWLEDGE_EXPORT_REPO";
export const KNOWLEDGE_EXPORT_BRANCH_ENV = "MYRMIDON_KNOWLEDGE_EXPORT_BRANCH";
export const KNOWLEDGE_EXPORT_INTERVAL_HOURS_ENV = "MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS";

const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function readKnowledgeExportSettings(env: NodeJS.ProcessEnv = process.env): KnowledgeExportSettings {
  const repoUrl = env[KNOWLEDGE_EXPORT_REPO_ENV]?.trim() || null;
  const branchRaw = env[KNOWLEDGE_EXPORT_BRANCH_ENV]?.trim() || KNOWLEDGE_EXPORT_DEFAULT_BRANCH;
  const branch = BRANCH_RE.test(branchRaw) && !branchRaw.includes("..") ? branchRaw : KNOWLEDGE_EXPORT_DEFAULT_BRANCH;
  const hoursRaw = Number(env[KNOWLEDGE_EXPORT_INTERVAL_HOURS_ENV]);
  const intervalHours = Number.isInteger(hoursRaw) && hoursRaw >= 1 && hoursRaw <= 168 ? hoursRaw : 24;
  return {
    enabled: repoUrl !== null && repoUrl.length > 0,
    repoUrl,
    branch,
    intervalHours,
  };
}
