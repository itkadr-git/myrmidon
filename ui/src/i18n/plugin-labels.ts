// myrmidon(OPE-9352): localized names of closed plugins in the board shell.
// Plugin manifests carry English display names (the board's base language);
// the fork catalog may translate them under
// `pluginLabels.<pluginKey with dots replaced by _>.<slot/launcher id | _plugin>`.
// A missing key returns the manifest text unchanged, for any language.

type LabelTranslate = (key: string, options?: { defaultValue?: string }) => string;

export const PLUGIN_LABEL_SELF = "_plugin";

export function pluginLabelKey(pluginKey: string, id: string | null | undefined): string {
  return `pluginLabels.${pluginKey.replace(/\./g, "_")}.${id || PLUGIN_LABEL_SELF}`;
}

export function pluginLabel(
  t: LabelTranslate,
  pluginKey: string | null | undefined,
  id: string | null | undefined,
  fallback: string,
): string {
  if (!pluginKey) return fallback;
  const key = pluginLabelKey(pluginKey, id);
  const translated = t(key, { defaultValue: fallback });
  // A translator that echoes the key (or returns nothing) means "no entry".
  return typeof translated === "string" && translated.length > 0 && translated !== key ? translated : fallback;
}
