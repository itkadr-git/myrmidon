// myrmidon(1.6.5-HERMES-SKILLS-A): deliver Paperclip-managed skills to a
// gateway-profile agent and verify the delivery by reading the profile back.
//
// Route decision (the ticket's part 2б): the hermes API surface of the pinned
// image (gateway/platforms/api_server.py route table) has no endpoint that
// reads or writes a profile's config.yaml or its skills directory, so the
// preferred route (patching skills.external_dirs through the gateway API) is
// not available. Skills are delivered through a new run-body field,
// paperclip_skills: {path, name, content} entries that
// docker/bot-runtime/patches/13-run-scoped-paperclip-skills.patch materializes
// into the profile's own skills root before the agent starts (the same
// contract run-scoped fields github_broker/workspace/github_launcher already
// use). The receiver side of that patch verifies each entry landed and fails
// the run loudly otherwise; the fact-check here verifies the assembled field
// carries every desired entry before it is sent, so a mismatch fails before
// the POST rather than after it.

import {
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

export const PAPERCLIP_SKILLS_FIELD = "paperclip_skills";

export interface GatewaySkillEntry {
  /** Relative materialization path inside the profile's skills root. */
  path: string;
  /** Frontmatter name the receiver checks after materialization. */
  name: string;
  /** SKILL.md content (text; hermes skill files are markdown). */
  content: string;
}

export interface GatewaySkillsReconcileResult {
  /** Run-body field value, in canonical path order. */
  skills: GatewaySkillEntry[];
  /** Desired keys after canonicalization. */
  desiredSkills: string[];
  /**
   * What the fact-check requires, as delivered names: each desired key paired
   * with the field the entry `name` is built from (runtimeName, i.e.
   * `<slug>--<hash>` for company skills). The check compares names, never the
   * key's last segment, which is only the slug.
   */
  desiredEntries: Array<{ key: string; name: string }>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The run-body field a card could forge through payloadTemplate. Reconcile
 * sets the field unconditionally after the payloadTemplate spread, so a card
 * value is replaced with the entries derived from paperclipRuntimeSkills —
 * or with `undefined` when the config carries no paperclipRuntimeSkills key at
 * all (reconcile is null; JSON serialization drops the field). When the key is
 * present but the desired set is empty, the field is `[]`: the receiver treats
 * an empty list as "clear this profile's managed segment", which is how an
 * unassigned skill is taken away from the bot. Same forgery rule as
 * buildGitHubBrokerField in execute.ts.
 */
export function buildPaperclipSkillsField(
  reconcile: GatewaySkillsReconcileResult | null,
): GatewaySkillEntry[] | undefined {
  return reconcile ? reconcile.skills : undefined;
}

/**
 * Derives the delivery entries from config.paperclipRuntimeSkills (+ the
 * desired-skills preference) and reads each desired skill's SKILL.md from its
 * source directory. Throws with the board-facing message when a desired skill
 * has no readable source: the run must not start without it.
 *
 * `readFile` is injectable so the tests exercise the module without touching
 * the filesystem.
 */
export async function reconcileGatewayPaperclipSkills(
  config: Record<string, unknown>,
  options: {
    moduleDir: string;
    onLog?: (line: string) => Promise<void> | void;
    readFile?: (path: string) => Promise<string>;
  },
): Promise<GatewaySkillsReconcileResult | null> {
  if (!Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    return null;
  }
  const readFile =
    options.readFile ?? ((await import("node:fs/promises")).readFile as unknown as (path: string) => Promise<string>);
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, options.moduleDir);
  // Same desired-set contract as hermes_local (src/server/skills.ts:216-222):
  // resolveLegacyPaperclipDesiredSkillNames returns [] when the config carries
  // no explicit paperclipSkillSync.desiredSkills preference, and an empty
  // desired set delivers nothing. Do not invent a "mount everything" default
  // here — the gateway and local adapters must agree.
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const entries: GatewaySkillEntry[] = [];
  const desiredEntries: Array<{ key: string; name: string }> = [];
  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) {
      throw new Error(
        `Cannot start without the required Paperclip-managed skills: ${entry.key}: skill source is missing`,
      );
    }
    const source = asString(entry.source);
    if (!source) {
      throw new Error(
        `Cannot start without the required Paperclip-managed skills: ${entry.key}: skill source is missing`,
      );
    }
    let content: string;
    try {
      content = await readFile(joinPath(source, "SKILL.md"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot start without the required Paperclip-managed skills: ${entry.key}: cannot read the skill source (${reason})`,
      );
    }
    const name = asString(entry.runtimeName) ?? entry.key.split("/").pop() ?? entry.key;
    if (entries.some((e) => e.name === name)) {
      // Two desired skills would land in the same segment directory and the
      // second would silently overwrite the first.
      throw new Error(
        `Cannot start without the required Paperclip-managed skills: ${entry.key}: another desired skill already uses the delivered name ${name}`,
      );
    }
    entries.push({ path: name, name, content });
    desiredEntries.push({ key: entry.key, name });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length > 0) {
    await options.onLog?.(
      `[hermes-gateway] Delivering ${entries.length} Paperclip-managed skill(s) in the run body: ${entries.map((e) => e.name).join(", ")}\n`,
    );
  }
  return { skills: entries, desiredSkills, desiredEntries };
}

function joinPath(dir: string, leaf: string): string {
  return dir.endsWith("/") ? `${dir}${leaf}` : `${dir}/${leaf}`;
}

/**
 * The fact-check: after the run body is assembled (and only when the delivery
 * actually carries skills), require every desired entry to be present in the
 * field the POST will send. The receiver side (the image patch) re-verifies
 * by reading the profile's skills root after materialization and fails the
 * run loudly when an entry did not land; this check is the earlier, board-side
 * half of the same contract — it never trusts this module's own log, it reads
 * the field that is about to cross the wire.
 *
 * Throws a message of the form
 * "Cannot start without the required Paperclip-managed skills: <skill>: <reason>"
 * (the hermes_local execute.ts:386 mirror) when a desired skill is absent.
 */
export function factCheckGatewayPaperclipSkills(input: {
  skills: GatewaySkillEntry[];
  desiredEntries: Array<{ key: string; name: string }>;
}): void {
  const present = new Set(input.skills.map((s) => s.name));
  for (const { key, name } of input.desiredEntries) {
    if (!present.has(name)) {
      throw new Error(
        `Cannot start without the required Paperclip-managed skills: ${name}: missing from the assembled run-body field`,
      );
    }
  }
}
