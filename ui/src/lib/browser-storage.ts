const LEGACY_PREFIXES = ["paperclip.", "paperclip:"] as const;

/** Convert one browser-storage namespace while preserving its separator style. */
export function myrmidonStorageKey(key: string): string {
  for (const prefix of LEGACY_PREFIXES) {
    if (key.startsWith(prefix)) return `myrmidon${key.slice("paperclip".length)}`;
  }
  return key;
}

/**
 * Move legacy Paperclip browser state to the Myrmidon namespace.
 * Storage APIs are synchronous, so this runs before the first React render.
 * Existing Myrmidon values always win; an empty value is eligible for migration.
 */
export function migrateLegacyStorage(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }

  for (const legacyKey of keys) {
    const nextKey = myrmidonStorageKey(legacyKey);
    try {
      const legacyValue = storage.getItem(legacyKey);
      const currentValue = storage.getItem(nextKey);
      if ((currentValue === null || currentValue === "") && legacyValue !== null) {
        storage.setItem(nextKey, legacyValue);
      }
      storage.removeItem(legacyKey);
    } catch {
      // Restricted/private browser contexts can reject storage operations.
    }
  }
}

export function migrateLegacyBrowserStorage(): void {
  if (typeof window === "undefined") return;
  try {
    migrateLegacyStorage(window.localStorage);
  } catch {
    // Ignore unavailable local storage.
  }
  try {
    migrateLegacyStorage(window.sessionStorage);
  } catch {
    // Ignore unavailable session storage.
  }
}
