// Grouped /model menu (myrmidon 1.6.6 MODEL-MENU B):
// GET/PATCH /api/myrmidon/model-menu.
//
// GET reports the menu in force: the stored tree, the catalog it was resolved
// against and the groups the bot would show. PATCH saves the tree to the
// instance settings and it applies immediately — /model reads that row on every
// command, so a save in the board is in the Telegram menu without a restart.
import { api } from "@/api/client";

export type ModelMenuSource = "settings" | "default";

/** One model of the resolved menu. */
export interface ModelMenuModel {
  id: string;
  label: string;
}

/** One group of the resolved menu: a title, its models and its subgroups. */
export interface ModelMenuNode {
  title: string;
  family?: string;
  models: ModelMenuModel[];
  children: ModelMenuNode[];
}

/** One group of the stored tree, as the editor writes it. */
export interface ModelMenuGroupDraft {
  title: string;
  models?: string[];
  children?: ModelMenuGroupDraft[];
}

/** The stored row: absent groups mean "group automatically". */
export interface ModelMenuStored {
  groups?: ModelMenuGroupDraft[];
  hidden?: string[];
}

export interface ModelMenuView {
  adapterType: string;
  adapterTypes: Array<{ type: string; label: string }>;
  catalog: Array<{ id: string; label?: string }>;
  stored: ModelMenuStored | null;
  menu: {
    groups: ModelMenuNode[];
    visibleModelIds: string[];
    hiddenModelIds: string[];
    missingModelIds: string[];
    duplicateModelIds: string[];
    newModelIds: string[];
    source: ModelMenuSource;
  };
}

export const modelMenuQueryKey = (adapterType?: string) =>
  ["myrmidon", "model-menu", adapterType ?? "default"] as const;

function menuUrl(adapterType?: string): string {
  return adapterType
    ? `/myrmidon/model-menu?adapterType=${encodeURIComponent(adapterType)}`
    : "/myrmidon/model-menu";
}

export const modelMenuApi = {
  get: (adapterType?: string) => api.get<ModelMenuView>(menuUrl(adapterType)),
  update: (patch: ModelMenuStored, adapterType?: string) =>
    api.patch<ModelMenuView>(menuUrl(adapterType), patch),
};