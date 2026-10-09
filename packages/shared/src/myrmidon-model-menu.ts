// packages/shared/src/myrmidon-model-menu.ts
//
// myrmidon(1.6.6 MODEL-MENU A): the model menu — the group tree the owner
// arranges in the board, and the pure functions that turn it, together with
// the gateway model catalog, into the menu the bot shows.
//
// 1.6.5 taught `/model` to list the chat models of the gateway catalog flat:
// one button per model, the tail of a long catalog by number. The owner's
// decision of 10.10 is the next step: the list becomes a menu of groups
// (Google / DeepSeek / z.ai / DashScope …), and the owner decides in the web
// interface which models are visible, how they are grouped and how deep the
// nesting goes.
//
// This module is the one place that knows the settings shape and the
// resolution rules, so the web editor, the settings API and the bot render one
// and the same menu out of one and the same input:
//
//  - `modelMenuSettingsSchema` — the canonical stored shape of
//    `instance_settings.general.modelMenu`: a tree of groups of arbitrary
//    depth (title, models, nested groups) plus the list of hidden models.
//  - with no tree stored (`groups` absent or empty) the menu is built
//    automatically: one group per provider/family of the catalog, DashScope
//    first, then z.ai, then the rest, so the 1.6.5 order survives.
//  - a catalog model the tree does not mention is never lost: it lands in the
//    «Новые» group.
//  - `resolveModelMenu` filters the hidden models out, drops the models a
//    group names but the catalog does not offer, and reports both lists
//    instead of inventing entries.
//
// Pure data and pure functions only — no addresses, no key values, no
// database access. The settings row is validated as a whole: a hand-edited
// value that does not match is ignored entirely and the automatic menu is
// shown, never half of the tree.
//
// The menu applies live: the caller re-reads the settings row and the catalog
// on every `/model`, so a PATCH in the web interface needs no restart.

import { z } from "zod";

/** Longest accepted group title. */
export const MODEL_MENU_MAX_GROUP_TITLE_CHARS = 64;

/** Most models one group may list. */
export const MODEL_MENU_MAX_MODELS_PER_GROUP = 500;

/**
 * Most child groups one group may hold. Counted by the settings walker rather
 * than by the schema: a wrapped self-reference is what makes a recursive zod
 * type complain, so the tree's own limits live in `fitsModelMenuLimits`.
 */
export const MODEL_MENU_MAX_CHILDREN_PER_GROUP = 100;

/** Most top-level groups. */
export const MODEL_MENU_MAX_GROUPS = 100;

/** Most hidden model ids. */
export const MODEL_MENU_MAX_HIDDEN_MODELS = 2000;

/**
 * Deepest accepted nesting: the root counts as depth 1, so 8 allows seven
 * levels of nested groups below the first screen. Deeper trees are refused as
 * a whole (`normalizeModelMenuSettings` returns null) — a menu nobody can
 * navigate is not better than the automatic one.
 */
export const MODEL_MENU_MAX_DEPTH = 8;

/** Longest accepted model id in the settings row. */
export const MODEL_MENU_MAX_MODEL_ID_CHARS = 512;

/** Default title of the group that collects the catalog models the tree misses. */
export const MODEL_MENU_NEW_GROUP_TITLE = "Новые";

/** Default title of the group that collects the families the tree misses. */
export const MODEL_MENU_OTHER_GROUP_TITLE = "Прочие";

/** Family key of a model that matches no known provider. */
export const MODEL_MENU_OTHER_FAMILY_KEY = "other";

/**
 * One group of the configured tree: a title, the models it lists (by catalog
 * id) and, optionally, nested groups. Every field but the title may be absent;
 * an empty group is dropped by the resolver rather than shown.
 *
 * Recursion goes through a getter (the pattern the zod docs give for recursive
 * types), and the object is built with `z.strictObject` rather than
 * `z.object({...}).strict()`: `.strict()` reads `.shape` while this very
 * binding is still being initialised, which throws on module load.
 */
export const modelMenuGroupSchema = z.strictObject({
  title: z.string().trim().min(1).max(MODEL_MENU_MAX_GROUP_TITLE_CHARS),
  models: z
    .array(z.string().trim().min(1).max(MODEL_MENU_MAX_MODEL_ID_CHARS))
    .max(MODEL_MENU_MAX_MODELS_PER_GROUP)
    .optional(),
  /**
   * Nested groups. The getter is what makes the type recursive (zod:
   * "recursive objects"), with the return type spelled out because a wrapped
   * self-reference is one of the cases the docs say to annotate.
   */
  get children(): z.ZodOptional<z.ZodArray<typeof modelMenuGroupSchema>> {
    return z.array(modelMenuGroupSchema).optional();
  },
});

export type ModelMenuGroup = z.infer<typeof modelMenuGroupSchema>;

/** The canonical stored shape of `instance_settings.general.modelMenu`. */
export const modelMenuSettingsSchema = z
  .object({
    groups: z.array(modelMenuGroupSchema).max(MODEL_MENU_MAX_GROUPS).optional(),
    hidden: z
      .array(z.string().trim().min(1).max(MODEL_MENU_MAX_MODEL_ID_CHARS))
      .max(MODEL_MENU_MAX_HIDDEN_MODELS)
      .optional(),
  })
  .strict();

export type ModelMenuSettings = z.infer<typeof modelMenuSettingsSchema>;

/** Body of `PATCH /api/myrmidon/model-menu`: the same shape, every key optional. */
export const patchModelMenuSettingsSchema = modelMenuSettingsSchema;

export type ModelMenuSettingsPatch = ModelMenuSettings;

/** One model as the gateway catalog offers it. */
export interface ModelMenuCatalogModel {
  /** Catalog id, the value the settings tree names and the bot applies. */
  id: string;
  /** Human label; the id stands in when the catalog carries none. */
  label?: string;
}

/** One model of the resolved menu. */
export interface ModelMenuModel {
  id: string;
  label: string;
}

/** One group of the resolved menu. */
export interface ModelMenuNode {
  title: string;
  /** Provider family of an automatically built group; absent on configured ones. */
  family?: string;
  models: ModelMenuModel[];
  children: ModelMenuNode[];
}

/** Where the menu in force came from: the settings row or the automatic rule. */
export type ModelMenuSource = "settings" | "default";

/** The menu the bot shows, plus the bookkeeping the API and the tests assert on. */
export interface ResolvedModelMenu {
  groups: ModelMenuNode[];
  /** Every model id reachable in the menu, in menu order. */
  visibleModelIds: string[];
  /** Hidden ids that the catalog actually offers. */
  hiddenModelIds: string[];
  /** Ids the tree names that the catalog does not offer (dropped, not invented). */
  missingModelIds: string[];
  /** Ids the tree names more than once; the first position wins. */
  duplicateModelIds: string[];
  /** Catalog ids that landed in the «Новые» group. */
  newModelIds: string[];
  source: ModelMenuSource;
}

/** One known provider family: how a catalog id is recognised and how it is titled. */
export interface ModelMenuFamily {
  key: string;
  title: string;
  pattern: RegExp;
}

/**
 * The families the automatic menu knows, in the order they are tried. A model
 * id matches the first family whose pattern it fits; the key of a miss is
 * `other`.
 */
export const MODEL_MENU_FAMILIES: readonly ModelMenuFamily[] = [
  { key: "dashscope", title: "DashScope", pattern: /^(qwen|qwq|wanx|tongyi)/i },
  { key: "zai", title: "z.ai", pattern: /^(glm|z-ai|zai)/i },
  { key: "google", title: "Google", pattern: /^(gemini|gemma|palm|text-bison)/i },
  { key: "deepseek", title: "DeepSeek", pattern: /^deepseek/i },
  { key: "openai", title: "OpenAI", pattern: /^(gpt|chatgpt|o[1-9](-|$)|text-|davinci|whisper|tts)/i },
  { key: "anthropic", title: "Anthropic", pattern: /^claude/i },
  { key: "xai", title: "xAI", pattern: /^grok/i },
  { key: "moonshot", title: "Moonshot", pattern: /^(kimi|moonshot)/i },
  { key: "mistral", title: "Mistral", pattern: /^(mistral|magistral|codestral|pixtral|devstral)/i },
  { key: "meta", title: "Meta", pattern: /^(llama|meta-llama)/i },
  { key: "minimax", title: "MiniMax", pattern: /^(minimax|abab)/i },
];

/** Families that come first, in this order; the rest follow alphabetically. */
export const MODEL_MENU_LEADING_FAMILIES: readonly string[] = ["dashscope", "zai"];

const FAMILY_BY_KEY = new Map(MODEL_MENU_FAMILIES.map((f) => [f.key, f]));

/** Key of the family a catalog id belongs to, or `other`. */
export function modelMenuFamilyKey(modelId: string): string {
  const id = modelId.trim();
  for (const family of MODEL_MENU_FAMILIES) {
    if (family.pattern.test(id)) return family.key;
  }
  return MODEL_MENU_OTHER_FAMILY_KEY;
}

/** Title of a family key as the automatic menu writes it. */
export function modelMenuFamilyTitle(key: string): string {
  if (key === MODEL_MENU_OTHER_FAMILY_KEY) return MODEL_MENU_OTHER_GROUP_TITLE;
  return FAMILY_BY_KEY.get(key)?.title ?? key;
}

/**
 * Family order of the automatic menu: the leading families first in their
 * declared order, then the rest alphabetically by title, `other` last.
 */
export function compareModelMenuFamilies(a: string, b: string): number {
  if (a === b) return 0;
  const leadA = MODEL_MENU_LEADING_FAMILIES.indexOf(a);
  const leadB = MODEL_MENU_LEADING_FAMILIES.indexOf(b);
  if (leadA !== -1 || leadB !== -1) {
    if (leadA === -1) return 1;
    if (leadB === -1) return -1;
    return leadA - leadB;
  }
  if (a === MODEL_MENU_OTHER_FAMILY_KEY) return 1;
  if (b === MODEL_MENU_OTHER_FAMILY_KEY) return -1;
  return modelMenuFamilyTitle(a).localeCompare(modelMenuFamilyTitle(b), "en");
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeModelMenuSettings(raw: unknown): ModelMenuSettings | null {
  const parsed = modelMenuSettingsSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (!fitsModelMenuLimits(parsed.data.groups ?? [], 1)) return null;
  return parsed.data;
}

/** Depth, width and model count of the tree are within their limits. */
function fitsModelMenuLimits(groups: readonly ModelMenuGroup[], depth: number): boolean {
  if (groups.length === 0) return true;
  if (depth > MODEL_MENU_MAX_DEPTH) return false;
  return groups.every(
    (group) =>
      (group.children?.length ?? 0) <= MODEL_MENU_MAX_CHILDREN_PER_GROUP &&
      fitsModelMenuLimits(group.children ?? [], depth + 1),
  );
}

function labelOf(model: ModelMenuCatalogModel): string {
  return model.label?.trim() || model.id;
}

/**
 * The menu in force: the configured tree over the catalog, or the automatic
 * grouping by provider when no tree is stored. Always returns a menu — an
 * unusable settings row falls back to the automatic one, never to half a tree.
 */
export function resolveModelMenu(options: {
  catalog: readonly ModelMenuCatalogModel[];
  settings?: unknown;
  /** «Новые» — the group of the catalog models the tree does not mention. */
  newGroupTitle?: string;
  /** «Прочие» — the automatic group of the families the family list misses. */
  otherGroupTitle?: string;
}): ResolvedModelMenu {
  const settings = normalizeModelMenuSettings(options.settings);
  const hidden = new Set((settings?.hidden ?? []).map((id) => id.trim()));

  // The catalog as an index, de-duplicated by id, in catalog order.
  const catalog = new Map<string, ModelMenuCatalogModel>();
  for (const model of options.catalog) {
    const id = model.id?.trim();
    if (!id || catalog.has(id)) continue;
    catalog.set(id, { id, label: model.label });
  }

  const hiddenModelIds = [...catalog.keys()].filter((id) => hidden.has(id));
  const usable = [...catalog.keys()].filter((id) => !hidden.has(id));
  const usableSet = new Set(usable);

  const missing: string[] = [];
  const duplicates: string[] = [];
  const placed = new Set<string>();

  const takeModel = (id: string): ModelMenuModel | null => {
    const trimmed = id.trim();
    if (!catalog.has(trimmed)) {
      missing.push(trimmed);
      return null;
    }
    if (!usableSet.has(trimmed)) return null; // hidden: silently absent
    if (placed.has(trimmed)) {
      duplicates.push(trimmed);
      return null;
    }
    placed.add(trimmed);
    return { id: trimmed, label: labelOf(catalog.get(trimmed)!) };
  };

  const groups = settings?.groups?.length
    ? resolveConfiguredGroups(settings.groups, takeModel)
    : buildAutomaticGroups(usable, catalog, options.otherGroupTitle);

  // The automatic grouping covers the whole catalog, so nothing is left over.
  if (!settings?.groups?.length) {
    for (const id of usable) placed.add(id);
  }

  const newGroupTitle = options.newGroupTitle ?? MODEL_MENU_NEW_GROUP_TITLE;
  const newModelIds = usable.filter((id) => !placed.has(id));
  if (newModelIds.length > 0) {
    const newGroup: ModelMenuNode = {
      title: newGroupTitle,
      models: newModelIds.map((id) => ({ id, label: labelOf(catalog.get(id)!) })),
      children: [],
    };
    for (const id of newModelIds) placed.add(id);
    groups.push(newGroup);
  }

  return {
    groups,
    visibleModelIds: collectModelIds(groups),
    hiddenModelIds,
    missingModelIds: dedupe(missing),
    duplicateModelIds: dedupe(duplicates),
    newModelIds,
    source: settings?.groups?.length ? "settings" : "default",
  };
}

/** The configured tree with the catalog consulted: empty groups are dropped. */
function resolveConfiguredGroups(
  groups: readonly ModelMenuGroup[],
  takeModel: (id: string) => ModelMenuModel | null,
): ModelMenuNode[] {
  const resolved: ModelMenuNode[] = [];
  for (const group of groups) {
    const children = resolveConfiguredGroups(group.children ?? [], takeModel);
    const models: ModelMenuModel[] = [];
    for (const id of group.models ?? []) {
      const model = takeModel(id);
      if (model) models.push(model);
    }
    if (models.length === 0 && children.length === 0) continue;
    resolved.push({ title: group.title, models, children });
  }
  return resolved;
}

/** One group per provider family of the catalog, in the family order. */
function buildAutomaticGroups(
  usable: readonly string[],
  catalog: Map<string, ModelMenuCatalogModel>,
  otherGroupTitle: string | undefined,
): ModelMenuNode[] {
  const byFamily = new Map<string, string[]>();
  for (const id of usable) {
    const key = modelMenuFamilyKey(id);
    const bucket = byFamily.get(key);
    if (bucket) bucket.push(id);
    else byFamily.set(key, [id]);
  }
  return [...byFamily.keys()]
    .sort(compareModelMenuFamilies)
    .map((key) => ({
      title:
        key === MODEL_MENU_OTHER_FAMILY_KEY
          ? otherGroupTitle ?? MODEL_MENU_OTHER_GROUP_TITLE
          : modelMenuFamilyTitle(key),
      family: key,
      models: byFamily.get(key)!.map((id) => ({ id, label: labelOf(catalog.get(id)!) })),
      children: [],
    }));
}

/** Every model id of the tree, in menu order. */
export function collectModelIds(groups: readonly ModelMenuNode[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const model of group.models) ids.push(model.id);
    ids.push(...collectModelIds(group.children));
  }
  return ids;
}

/** Total models of the tree. */
export function countModelMenuModels(groups: readonly ModelMenuNode[]): number {
  return groups.reduce(
    (total, group) => total + group.models.length + countModelMenuModels(group.children),
    0,
  );
}

/** Deepest nesting of the tree, the root counting as 1 (0 for an empty tree). */
export function modelMenuDepth(groups: readonly ModelMenuNode[]): number {
  let depth = 0;
  for (const group of groups) {
    depth = Math.max(depth, 1 + modelMenuDepth(group.children));
  }
  return depth;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}