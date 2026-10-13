import type {
  ModelMenuCatalogModel,
  ModelMenuSettings,
  ResolvedModelMenu,
} from "@paperclipai/shared";

/** One adapter type the editor may resolve a catalog against. */
export interface ModelMenuAdapterType {
  /** Adapter type, e.g. `hermes_gateway`; the picker stores it as-is. */
  type: string;
  /** Human label; the type itself stands in when the adapter carries none. */
  label: string;
}

/**
 * What `GET /api/myrmidon/model-menu` answers and what `PATCH` echoes back
 * (myrmidon 1.6.6 MODEL-MENU, part B).
 *
 * The board panel and the bot read the same shape, so what the owner sees in
 * the editor is what `/model` shows: the catalog the menu was resolved against,
 * the stored row (`null` when nothing usable is stored) and the menu in force —
 * the tree of the settings, or the automatic groups when the row is absent or
 * unusable.
 */
export interface ModelMenuView {
  /** Adapter type the catalog was read from. */
  adapterType: string;
  /** Adapter types the editor can pick, in picker order. */
  adapterTypes: ModelMenuAdapterType[];
  /** Catalog of `adapterType`, in catalog order; empty when it offers none. */
  catalog: ModelMenuCatalogModel[];
  /** The stored row as read back, or `null` when the row is absent/unusable. */
  stored: ModelMenuSettings | null;
  /** The menu in force, with the visible/hidden/missing bookkeeping. */
  menu: ResolvedModelMenu;
}