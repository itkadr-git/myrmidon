// myrmidon(1.6.5-TG-LOCALE-D): the pure data layer of the "Telegram"
// section on the agent card — aliases, the group title and the metadata patch.
//
// Storage is `agents.metadata`:
//   - `telegramAliases: string[]` — explicit @-aliases the bridge answers to
//     (read by server/src/myrmidon/agent-chat-bridge/addressing.ts);
//   - `telegramGroup: string` — the free-text group title part A of the epic
//     shows in `/agents` (read by bridge grouping.ts).
// Everything else in metadata is operator data this section must never drop:
// the patch is built from the FRESH agent read and only touches the two keys.

/**
 * CONSOLIDATION-OPE-6318: mirror of `defaultAliasFromName` in
 * server/src/myrmidon/agent-chat-bridge/addressing.ts (part A kept the rule
 * server-side, not in @paperclipai/shared). Same rule: the last dash-separated
 * segment of the name, lower-cased, latin letters/digits/underscore only
 * (`adm-dev-eng-15` → `15`, `Wiki Maintainer` → `wikimaintainer`). A tail with
 * no latin character yields "" and the card shows no default. When the rule
 * moves to the shared package, drop this copy and import it from there.
 */
export function defaultTelegramAliasFromName(name: string): string {
  const segments = name.trim().toLowerCase().split("-");
  const tail = segments[segments.length - 1] ?? "";
  return tail.replace(/[^a-z0-9_]/g, "");
}

/** What the input field stores before saving: trimmed, lower-cased. */
export function normalizeTelegramAlias(raw: string): string {
  return raw.trim().toLowerCase();
}

/** An alias is lowercase latin letters, digits or underscores (bridge rule). */
export function isValidTelegramAlias(alias: string): boolean {
  return /^[a-z0-9_]+$/.test(alias);
}

/** The stored alias list; absent/non-array means "no override" (null). */
export function readStoredTelegramAliases(metadata: unknown): string[] | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).telegramAliases;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeTelegramAlias(entry);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

/** The stored group title, trimmed; null if absent or blank. */
export function readStoredTelegramGroup(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).telegramGroup;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the full replacement metadata for the PATCH: start from the fresh
 * stored metadata and touch only the two Telegram keys. Empty aliases clears
 * the key (the bridge then computes the default again); a blank group clears
 * the key so part A groups the card by its name prefix.
 */
export function buildTelegramMetadataPatch(
  storedMetadata: unknown,
  next: { aliases: string[]; group: string | null },
): Record<string, unknown> {
  const base =
    storedMetadata !== null && typeof storedMetadata === "object" && !Array.isArray(storedMetadata)
      ? { ...(storedMetadata as Record<string, unknown>) }
      : {};
  if (next.aliases.length > 0) base.telegramAliases = next.aliases;
  else delete base.telegramAliases;
  const group = next.group?.trim() ?? "";
  if (group) base.telegramGroup = group;
  else delete base.telegramGroup;
  return base;
}

/** The company's group titles already in use, deduplicated, for the datalist. */
export function collectTelegramGroupOptions(
  agents: readonly { metadata: unknown }[],
): string[] {
  const out: string[] = [];
  for (const agent of agents) {
    const group = readStoredTelegramGroup(agent.metadata);
    if (group && !out.includes(group)) out.push(group);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
