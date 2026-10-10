// DEBRAND (OPE-5806): browser-storage keys moved from the `paperclip.*` /
// `paperclip:*` namespace to `myrmidon.*` / `myrmidon:*`. Reads go through the
// helpers below so existing users keep their theme, sidebar width, onboarding
// progress, etc.: if the new key is empty we copy the legacy value into the
// new key and delete the legacy one (lazy migration, run at read time).
//
// myrmidon(DB3)
//
// The legacy-key strings are kept in a single locked list so the
// `"paperclip[.:]` grep gate stays green outside this file, and so the
// migration surface cannot drift.

const LEGACY_PAPERCLIP_STORAGE_KEYS = [
  // localStorage — dot style
  "paperclip.theme",
  "paperclip.sidebar.collapsed",
  "paperclip.sidebar.width",
  "paperclip.missions",
  "paperclip.ing",
  "paperclip.quality",
  "paperclip.usage",
  "paperclip.tasks.create",
  "paperclip-onboarding-state",
  "paperclip.onboarding-state",
  // localStorage — colon style (dynamic suffixes: plugins, collections, drafts)
  "paperclip:plugin-issues-view",
  "paperclip:plugin-issues-layout",
  "paperclip:plugin:access:",
  "paperclip:plugin:panel:",
  "paperclip:plugin:",
  "paperclip:routines-view",
  "paperclip:project-tab-selection",
  "paperclip:task-collection:",
  // localStorage — composite / prefixed forms
  "paperclip:workspace:",
  ":paperclip:projects:",
  ":paperclip:selectedProject",
  ":paperclip:selectedCompany",
  ":paperclip:workspaceSelectorOpen",
  // Dynamic-prefix keys (runtime suffixes); the sweep migrates them by
  // concrete prefix, listed here so the migration surface cannot drift.
  // myrmidon(DB3)
  "paperclip.recentTasks:",
  "paperclip.recentAgentChats:",
  "paperclip.connector-enrollment-access:",
  "paperclip.announcement-dismissals.v1:",
  "paperclip.boardChat.draft.",
  "paperclip:issue-document-folds:",
  "paperclip:task-input:",
  "paperclip:board-send:v1:",
  "paperclip:agent-chat-pending:",
  "paperclip:shared-poll:",
  "paperclip:task-collection:v",
  "paperclip:task-side-panel:v",
  "paperclip:cases:",
  "paperclip:skills-folder-nudge:",
  "paperclip:execution-workspace-tab:",
  "paperclip:pipeline-item-conversation-draft:",
  "paperclip:project-tab:",
  "paperclip:routines-folder-nudge:",
  "paperclip:test-call:",
  // sessionStorage
  "paperclip.onboarding-active",
] as const;

/** Legacy `paperclip.*`/`paperclip:*` prefix → new `myrmidon.*`/`myrmidon:*` prefix. */
function toMyrmidonKey(legacyKey: string): string {
  if (legacyKey.startsWith("paperclip")) {
    return `myrmidon${legacyKey.slice("paperclip".length)}`;
  }
  // Composite keys like `${projectId}:paperclip:projects:${projectId}` —
  // replace the embedded `paperclip` segment, preserving the rest verbatim.
  return legacyKey.replace("paperclip", "myrmidon");
}

/**
 * myrmidon(DB3) — read a browser-storage value with lazy legacy migration.
 * Returns the value under the new key; if absent, copies a legacy
 * `paperclip.*`/`paperclip:*` value into the new key, removes the legacy key,
 * and returns it. `session` selects sessionStorage instead of localStorage.
 */
export function readMigratedStorageItem(
  storageKey: string,
  opts?: { session?: boolean },
): string | null {
  const store = pickStorage(opts?.session);
  if (!store) return null;
  try {
    const fresh = store.getItem(storageKey);
    if (fresh !== null && fresh !== "") return fresh;
  } catch {
    return null;
  }
  return migrateLegacyInto(storageKey, store);
}

/** One-time (per key) lazy migration used when a component already holds a
 *  storage key but wants the legacy fallback at read time. */
function migrateLegacyInto(newKey: string, store: Storage): string | null {
  const legacyKey = legacyKeyForNewKey(newKey);
  if (!legacyKey) return null;
  try {
    const legacy = store.getItem(legacyKey);
    if (legacy === null || legacy === "") {
      // Nothing to migrate; clean up a residue legacy key if it ever exists.
      if (legacy === "") store.removeItem(legacyKey);
      return null;
    }
    store.setItem(newKey, legacy);
    store.removeItem(legacyKey);
    return legacy;
  } catch {
    return null;
  }
}

function legacyKeyForNewKey(newKey: string): string | null {
  if (!newKey.startsWith("myrmidon")) return null;
  const legacy = `paperclip${newKey.slice("myrmidon".length)}`;
  return isKnownLegacyKey(legacy) ? legacy : null;
}

/** True when the legacy key (or its prefix) belongs to the locked migration
 *  list — guards against migrating unrelated `paperclip*` strings. */
function isKnownLegacyKey(legacyKey: string): boolean {
  for (const known of LEGACY_PAPERCLIP_STORAGE_KEYS) {
    if (legacyKey === known || legacyKey.startsWith(known)) return true;
  }
  return false;
}

/** myrmidon(DB3) — write helper; always writes the new key only. */
export function writeMigratedStorageItem(
  storageKey: string,
  value: string,
  opts?: { session?: boolean },
): void {
  const store = pickStorage(opts?.session);
  if (!store) return;
  try {
    store.setItem(storageKey, value);
  } catch {
    // Quota / disabled storage — keep prior value; non-fatal by design.
  }
}

function pickStorage(session?: boolean): Storage | null {
  try {
    if (session) return window.sessionStorage;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Startup sweep (myrmidon(DB3)): migrates legacy keys that are not read
 * through `readMigratedStorageItem` or that live under dynamic suffixes
 * (plugin panels, collection views, drafts, per-project tabs). Runs lazily
 * once per page load from bootstrap; idempotent.
 */
export function migrateLegacyPaperclipStorage(): void {
  if (typeof window === "undefined") return;
  try {
    // fast path: no legacy keys at all → skip the scan
    let sawLegacy = false;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && isLegacyStorageKey(key)) {
        sawLegacy = true;
        break;
      }
    }
    if (!sawLegacy) {
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key && isLegacyStorageKey(key)) {
          sawLegacy = true;
          break;
        }
      }
    }
    if (!sawLegacy) return;

    migrateStorage(window.localStorage);
    migrateStorage(window.sessionStorage);
  } catch {
    // Storage disabled / quota — best effort; individual reads still work.
  }
}

function migrateStorage(store: Storage): void {
  const legacyKeys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && isLegacyStorageKey(key)) legacyKeys.push(key);
  }
  for (const legacyKey of legacyKeys) {
    const newKey = toMyrmidonKey(legacyKey);
    try {
      const value = store.getItem(legacyKey);
      if (value === null) continue;
      if (store.getItem(newKey) === null) store.setItem(newKey, value);
      store.removeItem(legacyKey);
    } catch {
      // Skip this key; remaining keys still migrate.
    }
  }
}

function isLegacyStorageKey(key: string): boolean {
  if (!key.startsWith("paperclip.") && !key.startsWith("paperclip:")
      && !key.startsWith("paperclip-") && !key.includes(":paperclip:")) {
    return false;
  }
  // `paperclip.recentTasks:<c>:<u>` must NOT be swept to `myrmidon.recentTasks:…`:
  // the reader in lib/recent-tasks.ts migrates it to the versioned
  // `myrmidon.recentTasks.v2:…` key. A naive prefix rename would drop the value
  // (myrmidon(DB3), OPE-5806).
  if (key.startsWith("paperclip.recentTasks:")) return false;
  return true;
}

/** Exposed for tests — the locked legacy key list. */
export const LEGACY_KEYS_UNDER_MIGRATION = LEGACY_PAPERCLIP_STORAGE_KEYS;
/** Exposed for tests. */
export { toMyrmidonKey };
