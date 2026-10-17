// server/src/myrmidon/bot-containers/profile-skills.ts
//
// myrmidon(W2a): the skills half of the profile compile's ports, kept out of the
// database glue (profile-ports.ts) so the rules — which skill reaches which bot,
// what a blocked, missing or oversized one reports — are tested against fake
// readers, like the rest of the compiler input.
//
// myrmidon(PERF-DIET-G): the reads behind those rules are company-scoped and
// identical for every bot of a company, so a pass (profile-pass.ts) pays each of
// them once instead of once per bot: the lifecycle delivery of the company's
// skills, the runtime catalogue for a given set of version pins, and the skill
// files on disk (a skill shared by two bots is read once). What is genuinely
// per-agent — the card's own skill list, its version pins and its warnings —
// still runs for every bot, so the compiled profile of each bot is unchanged.

import fs from "node:fs/promises";
import path from "node:path";

import {
  readPaperclipSkillSyncPreference,
  resolveLegacyPaperclipDesiredSkillNames,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { skillVersionSelectionMap } from "../../services/runtime-skill-selections.js";
import type { SkillLifecycleDelivery, SkillLifecycleReadCache } from "../skill-lifecycle/index.js";
import type { BotProfileAgentRecord } from "./profile-compile.js";
import type { HermesProfileSkillFile } from "./profile-compiler.js";
import type { BotProfilePassReader } from "./profile-pass.js";

const SKILL_MAX_FILES = 200;
const SKILL_MAX_FILE_BYTES = 512 * 1024;
const SKILL_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** Reads a materialized skill directory into compiler input. Symlinks, oversized
 *  and binary files are skipped with a warning, never followed or truncated. */
export async function readSkillFiles(
  root: string,
  label: string,
  warnings: string[],
): Promise<HermesProfileSkillFile[]> {
  const files: HermesProfileSkillFile[] = [];
  const rootStat = await fs.stat(root);
  if (rootStat.isFile()) {
    return [{ path: "SKILL.md", content: await fs.readFile(root, "utf8") }];
  }

  async function walk(directory: string, relative: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        warnings.push(`skill ${label}: symlink ${relativePath} skipped`);
        continue;
      }
      if (entry.isDirectory()) {
        if (SKILL_SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= SKILL_MAX_FILES) {
        warnings.push(`skill ${label}: more than ${SKILL_MAX_FILES} files, ${relativePath} and the rest skipped`);
        return;
      }
      const absolute = path.join(directory, entry.name);
      const stat = await fs.stat(absolute);
      if (stat.size > SKILL_MAX_FILE_BYTES) {
        warnings.push(`skill ${label}: ${relativePath} is larger than ${SKILL_MAX_FILE_BYTES} bytes, skipped`);
        continue;
      }
      const content = await fs.readFile(absolute, "utf8");
      if (content.includes("\u0000")) {
        warnings.push(`skill ${label}: ${relativePath} is binary, skipped`);
        continue;
      }
      files.push({ path: relativePath, content });
    }
  }

  await walk(root, "");
  return files;
}

/** What the skill resolution needs from the board. profile-ports.ts binds it to
 *  the database services; the tests pass fakes that count their calls. */
export interface BotProfileSkillReaders {
  /** The instance setting that decides whether a card's own version pins apply
   *  (`experimental.enableBetaSkills`). */
  readExperimental(): Promise<{ enableBetaSkills?: boolean }>;
  /** The lifecycle delivery of one agent. `cache` shares the company-wide reads
   *  behind it (skill-lifecycle/service.ts `resolveDelivery`) with the pass; the
   *  decision itself stays per agent. */
  resolveLifecycle(
    companyId: string,
    agentId: string,
    cache?: SkillLifecycleReadCache,
  ): Promise<SkillLifecycleDelivery>;
  /** The company's runtime skill catalogue with these version selections. */
  listRuntimeSkillEntries(
    companyId: string,
    options: { versionSelections: Map<string, string | null> },
  ): Promise<PaperclipSkillEntry[]>;
}

export interface BotProfileSkillsResult {
  skills: Record<string, readonly HermesProfileSkillFile[]>;
  warnings: string[];
}

/**
 * Stable identity of a set of version selections: two bots that pin the same
 * revisions share one catalogue read, and a bot with its own pins gets its own
 * (the catalogue is resolved per selection set, so sharing across different sets
 * would hand a bot another bot's revisions).
 */
export function versionSelectionSignature(selections: Map<string, string | null>): string {
  return [...selections.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, versionId]) => `${key}=${versionId ?? ""}`)
    .join(",");
}

/** The skill files of one materialized skill directory, with the warnings its
 *  read produced. Shared through the pass: two bots carrying the same skill
 *  (same key, same source) read the directory once. */
async function skillFilesFor(
  key: string,
  source: string,
  pass: BotProfilePassReader | undefined,
): Promise<{ files: HermesProfileSkillFile[]; warnings: string[] }> {
  const read = async () => {
    const warnings: string[] = [];
    return { files: await readSkillFiles(source, key, warnings), warnings };
  };
  return pass ? pass.once(`skill-files:${key}:${source}`, read) : read();
}

/**
 * The skills port (`BotProfilePorts.loadSkills`): the company catalog filtered
 * and pinned by the lifecycle, narrowed to the card's own desired skills, read
 * as files. Every company-scoped read goes through `pass` when one is given.
 */
export function createBotProfileSkillLoader(
  readers: BotProfileSkillReaders,
): (agent: BotProfileAgentRecord, pass?: BotProfilePassReader) => Promise<BotProfileSkillsResult> {
  return async function loadSkills(agent, pass) {
    const warnings: string[] = [];
    const preference = readPaperclipSkillSyncPreference(agent.adapterConfig);
    const read = <T>(key: string, source: () => Promise<T>): Promise<T> =>
      pass ? pass.once(key, source) : source();
    const experimental = await read("experimental-skills", () => readers.readExperimental());
    // myrmidon(1.6-SKILL-LIFE): the company lifecycle decides what reaches
    // this agent — a deprecated skill reaches nobody, a candidate only the
    // pilot agent set, and a verified skill is pinned to its verified
    // revision, so a rollback takes effect on the next compile tick.
    const lifecycle = await readers.resolveLifecycle(agent.companyId, agent.id, pass);
    const versionSelections = skillVersionSelectionMap(preference.desiredSkillEntries, {
      versionPinsEnabled: experimental.enableBetaSkills === true,
    });
    for (const [key, versionId] of lifecycle.pinnedVersions) {
      // The card's own pin wins when it set one; the lifecycle fills the rest.
      if (!versionSelections.get(key)) versionSelections.set(key, versionId);
    }
    const entries = await read(
      `runtime-skill-entries:${agent.companyId}:${versionSelectionSignature(versionSelections)}`,
      () => readers.listRuntimeSkillEntries(agent.companyId, { versionSelections }),
    );
    // The same resolution hermes_local uses, so a bot in a container carries the
    // skills it would have had running locally (including the board's own skill).
    const desiredKeys = resolveLegacyPaperclipDesiredSkillNames(agent.adapterConfig, entries);
    const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
    const result: Record<string, readonly HermesProfileSkillFile[]> = {};
    for (const key of desiredKeys) {
      if (lifecycle.blockedKeys.has(key)) {
        warnings.push(
          lifecycle.reasons.get(key) ?? `skill ${key}: withheld by the skill lifecycle`,
        );
        continue;
      }
      const entry = byKey.get(key);
      if (!entry) {
        warnings.push(`skill ${key}: not found in the company catalog, skipped`);
        continue;
      }
      if (entry.sourceStatus === "missing") {
        warnings.push(`skill ${key}: source is missing (${entry.missingDetail ?? "no detail"}), skipped`);
        continue;
      }
      const shared = await skillFilesFor(key, entry.source, pass);
      // The warnings a shared read produced are reported for every bot that
      // carries the skill, not only for the one that paid for the read.
      warnings.push(...shared.warnings);
      result[entry.runtimeName] = shared.files;
    }
    return { skills: result, warnings };
  };
}