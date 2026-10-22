// server/src/myrmidon/agent-chat-bridge/model-menu.ts
//
// myrmidon(1.6.6 MODEL-MENU A): the screens of the `/model` menu — first-level
// groups, the expansion of a group, «Назад» and «Ещё →».
//
// The tree itself (and the rules that turn the owner's settings and the
// gateway catalog into it) lives in `@paperclipai/shared`
// (`myrmidon-model-menu.ts`). This module is the presentation layer of the
// bridge: given the resolved menu and a position in it, it answers which
// entries one message shows and which position every entry leads to.
//
// Nothing here knows about Telegram or about the transport that carries the
// buttons: an entry is `{ kind, label }` plus the position it opens, so the
// same screens serve inline buttons, a numbered reply or a preview in the web
// editor. The labels that are interface words («Назад», «Ещё →», the root
// title) are passed in by the caller, which reads them from the bridge's
// locales like every other command string.
//
// Telegram's limits decide the two numbers: a message carries at most 100
// inline buttons, and a screen the owner can read holds far fewer, so a level
// is paged `MODEL_MENU_PAGE_SIZE` entries at a time and the last row of a page
// is «Ещё →» until the level ends. A group nested any number of levels deep is
// one path away: the path is the list of child indexes from the root, and the
// «Назад» entry is that path without its last element.

import type {
  ModelMenuModel,
  ModelMenuNode,
  ResolvedModelMenu,
} from "@paperclipai/shared";

/** Telegram refuses a keyboard with more than 100 buttons; keep a spare row for navigation. */
export const MODEL_MENU_MAX_ENTRIES = 96;

/** Entries of one level shown on one screen. */
export const MODEL_MENU_PAGE_SIZE = 20;

/** Longest label of one button. */
export const MODEL_MENU_ENTRY_LABEL_MAX_CHARS = 60;

/** What one entry of a screen stands for. */
export type ModelMenuEntryKind = "group" | "model" | "back" | "more";

/** One entry of a screen: a button, its label and where it leads. */
export interface ModelMenuEntry {
  kind: ModelMenuEntryKind;
  label: string;
  /** Target position of a group entry (the path of that group). */
  path?: number[];
  /** Model id of a model entry: the value the bot applies to the next turn. */
  modelId?: string;
  /** Target page of a «Ещё →» entry. */
  page?: number;
}

/** One message of the menu: the position, its entries and the paging state. */
export interface ModelMenuScreen {
  /** Position shown: the list of child indexes from the root, empty at the root. */
  path: number[];
  /** Page of this position, zero-based, clamped into range. */
  page: number;
  /** Pages this position has. */
  pageCount: number;
  /** Entries of the position before paging. */
  total: number;
  /** Title of the position: the root title or the title of the group. */
  title: string;
  /** The entries this screen shows, navigation rows last. */
  entries: ModelMenuEntry[];
}

/** Interface words of the menu, read from the bridge's locales by the caller. */
export interface ModelMenuScreenLabels {
  /** Title of the first screen (the level above the first groups). */
  rootTitle: string;
  /** «Назад» — up one level. */
  back: string;
  /** «Ещё →» — the next page of this level. */
  more: string;
  /** Label of a group entry; the group's title by default. */
  groupLabel?: (node: ModelMenuNode, index: number) => string;
  /** Label of a model entry; the model's label by default. */
  modelLabel?: (model: ModelMenuModel) => string;
}

/** Cuts a label to what a button carries, marking the cut. */
export function truncateModelMenuEntryLabel(
  label: string,
  max: number = MODEL_MENU_ENTRY_LABEL_MAX_CHARS,
): string {
  const trimmed = label.trim();
  if (trimmed.length <= max) return trimmed;
  const kept = trimmed.slice(0, Math.max(1, max - 1)).trimEnd();
  return `${kept}…`;
}

/** Total models of a group, nested groups included. */
export function modelMenuNodeModelCount(node: ModelMenuNode): number {
  return (
    node.models.length + node.children.reduce((sum, child) => sum + modelMenuNodeModelCount(child), 0)
  );
}

/**
 * The group a path names. The empty path is the root, which is not a group of
 * the tree: it is reported as a synthetic node with the top-level groups as
 * its children, so the root screen lists the first level like any other
 * screen lists its own.
 */
export function modelMenuNodeAtPath(
  menu: ResolvedModelMenu,
  path: readonly number[],
): ModelMenuNode | null {
  if (path.length === 0) {
    return { title: "", models: [], children: menu.groups };
  }
  let children = menu.groups;
  let node: ModelMenuNode | null = null;
  for (const index of path) {
    const child = children[index];
    if (!child) return null;
    node = child;
    children = child.children;
  }
  return node;
}

/**
 * The entries of one message: the subgroups and the models of the position,
 * the next page while the position has one, then «Назад» when the position is
 * not the root. Returns null when the path names no group — the caller keeps
 * the screen it had rather than showing an empty menu.
 */
export function buildModelMenuScreen(options: {
  menu: ResolvedModelMenu;
  /** Position to show; the root when omitted. */
  path?: readonly number[];
  /** Page to show; clamped into range, 0 when omitted. */
  page?: number;
  labels: ModelMenuScreenLabels;
}): ModelMenuScreen | null {
  const path = [...(options.path ?? [])];
  const node = modelMenuNodeAtPath(options.menu, path);
  if (!node) return null;

  const items: ModelMenuEntry[] = [
    ...node.children.map((child, index): ModelMenuEntry => ({
      kind: "group",
      label: truncateModelMenuEntryLabel(
        options.labels.groupLabel?.(child, index) ?? child.title,
      ),
      path: [...path, index],
    })),
    ...node.models.map((model): ModelMenuEntry => ({
      kind: "model",
      label: truncateModelMenuEntryLabel(
        options.labels.modelLabel?.(model) ?? model.label,
      ),
      modelId: model.id,
    })),
  ];

  // Navigation rows are reserved out of the button budget, so a page never
  // exceeds what one message may carry.
  const pageSize = Math.max(1, Math.min(MODEL_MENU_PAGE_SIZE, MODEL_MENU_MAX_ENTRIES - 2));
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(0, Math.trunc(options.page ?? 0)), pageCount - 1);
  const entries = items.slice(page * pageSize, (page + 1) * pageSize);

  if (page < pageCount - 1) {
    entries.push({ kind: "more", label: options.labels.more, page: page + 1 });
  }
  if (path.length > 0) {
    entries.push({ kind: "back", label: options.labels.back, path: path.slice(0, -1) });
  }

  return {
    path,
    page,
    pageCount,
    total: items.length,
    title: path.length === 0 ? options.labels.rootTitle : node.title,
    entries,
  };
}