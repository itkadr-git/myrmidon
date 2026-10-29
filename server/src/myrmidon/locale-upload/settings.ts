import { CUSTOM_LOCALES_SETTINGS_KEY } from \"@myrmidon/shared\";

export { CUSTOM_LOCALES_SETTINGS_KEY };

export function preserveCustomLocalesGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== \"object\" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[CUSTOM_LOCALES_SETTINGS_KEY];
  return value === undefined ? {} : { [CUSTOM_LOCALES_SETTINGS_KEY]: value };
}
