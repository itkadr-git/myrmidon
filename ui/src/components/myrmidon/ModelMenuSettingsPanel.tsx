// Grouped /model menu (1.6.6 MODEL-MENU B): which models the bot offers, in
// which groups, in which order and how deep the nesting goes. Saving writes the
// instance settings row that /model reads on every command, so the Telegram
// menu changes without a restart.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListTree, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  modelMenuApi,
  modelMenuQueryKey,
  type ModelMenuGroupDraft,
  type ModelMenuNode,
  type ModelMenuStored,
  type ModelMenuView,
} from "./modelMenuApi";

/** A position in the draft tree: the indices from the root down to the group. */
type GroupPath = number[];

function updateAt(
  groups: ModelMenuGroupDraft[],
  path: GroupPath,
  change: (group: ModelMenuGroupDraft) => ModelMenuGroupDraft,
): ModelMenuGroupDraft[] {
  const [head, ...rest] = path;
  return groups.map((group, index) => {
    if (index !== head) return group;
    if (rest.length === 0) return change(group);
    return { ...group, children: updateAt(group.children ?? [], rest, change) };
  });
}

function removeAt(groups: ModelMenuGroupDraft[], path: GroupPath): ModelMenuGroupDraft[] {
  const [head, ...rest] = path;
  if (rest.length === 0) return groups.filter((_, index) => index !== head);
  return groups.map((group, index) =>
    index === head ? { ...group, children: removeAt(group.children ?? [], rest) } : group,
  );
}

function moveAt(groups: ModelMenuGroupDraft[], path: GroupPath, delta: number): ModelMenuGroupDraft[] {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const target = head + delta;
    if (target < 0 || target >= groups.length) return groups;
    const next = [...groups];
    [next[head], next[target]] = [next[target], next[head]];
    return next;
  }
  return groups.map((group, index) =>
    index === head ? { ...group, children: moveAt(group.children ?? [], rest, delta) } : group,
  );
}

function draftFrom(view: ModelMenuStored | null): ModelMenuGroupDraft[] {
  return view?.groups ?? [];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** The resolved menu as indented lines, so a nested group reads as nested. */
function previewLines(nodes: ModelMenuNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"    ".repeat(depth)}${node.title} (${node.models.length})`,
    ...previewLines(node.children, depth + 1),
    ...node.models.map((model) => `${"    ".repeat(depth + 1)}· ${model.id}`),
  ]);
}

export function ModelMenuSettingsPanel() {
  const queryClient = useQueryClient();
  const [adapterType, setAdapterType] = useState<string | undefined>(undefined);
  const { data: view } = useQuery({
    queryKey: modelMenuQueryKey(adapterType),
    queryFn: () => modelMenuApi.get(adapterType),
    // The catalog selector changes the query key, so switching catalogs asks
    // again. Hold the previous answer while the next one is in flight: the
    // editor should not flash «Automatic groups» and an empty hidden-models
    // list between two catalogs of the same instance.
    placeholderData: (previous: ModelMenuView | undefined) => previous,
  });

  const [groups, setGroups] = useState<ModelMenuGroupDraft[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The draft starts from the stored tree and follows it when the query result
  // changes (adapter switch, or the response of a save).
  useEffect(() => {
    if (!view) return;
    setGroups(draftFrom(view.stored));
    setHidden(view.stored?.hidden ?? []);
    setLoaded(true);
  }, [view]);

  useEffect(() => {
    if (view && adapterType === undefined) setAdapterType(view.adapterType);
  }, [view, adapterType]);

  const save = useMutation({
    mutationFn: () =>
      modelMenuApi.update({ groups, hidden } satisfies ModelMenuStored, adapterType),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["myrmidon", "model-menu"] });
    },
    onError: () => setError("Could not save the menu. Try again."),
  });

  const dirty = loaded && (!sameValue(groups, view?.stored?.groups ?? []) || !sameValue(hidden, view?.stored?.hidden ?? []));
  const catalog = view?.catalog ?? [];
  const hiddenCandidates = [...new Set([...hidden, ...catalog.map((model) => model.id)])];

  const addModelTo = (path: GroupPath, id: string) => {
    if (!id) return;
    setGroups((current) =>
      updateAt(current, path, (group) => ({
        ...group,
        models: [...(group.models ?? []), id],
      })),
    );
  };

  const renderGroup = (group: ModelMenuGroupDraft, path: GroupPath) => (
    <li key={path.join(".")} className="space-y-2 rounded border p-2" data-testid={`model-menu-group-${path.join(".")}`}>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Group title"
          value={group.title}
          onChange={(event) =>
            setGroups((current) =>
              updateAt(current, path, (entry) => ({ ...entry, title: event.target.value })),
            )
          }
          data-testid={`model-menu-title-${path.join(".")}`}
        />
        <Button size="sm" variant="outline" onClick={() => setGroups((current) => moveAt(current, path, -1))}>
          <ArrowUp className="size-3" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setGroups((current) => moveAt(current, path, 1))}>
          <ArrowDown className="size-3" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setGroups((current) => removeAt(current, path))}>
          <Trash2 className="size-3" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(group.models ?? []).map((id, index) => (
          <span key={`${id}-${index}`} className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs">
            {id}
            <button
              type="button"
              aria-label={`Remove ${id}`}
              onClick={() =>
                setGroups((current) =>
                  updateAt(current, path, (entry) => ({
                    ...entry,
                    models: (entry.models ?? []).filter((_, position) => position !== index),
                  })),
                )
              }
            >
              ×
            </button>
          </span>
        ))}
        <select
          aria-label="Add a model"
          value=""
          data-testid={`model-menu-add-model-${path.join(".")}`}
          onChange={(event) => addModelTo(path, event.target.value)}
          className="h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Add a model…</option>
          {catalog.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label ?? model.id}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          data-testid={`model-menu-add-group-${path.join(".")}`}
          onClick={() =>
            setGroups((current) =>
              updateAt(current, path, (entry) => ({
                ...entry,
                children: [...(entry.children ?? []), { title: "Новая группа", models: [] }],
              })),
            )
          }
        >
          <Plus className="size-3" /> Subgroup
        </Button>
      </div>

      {(group.children ?? []).length > 0 && (
        <ul className="ml-4 space-y-2">
          {(group.children ?? []).map((child, index) => renderGroup(child, [...path, index]))}
        </ul>
      )}
    </li>
  );

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="model-menu-panel">
      <div className="flex items-center gap-2">
        <ListTree className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Model menu</h3>
        <span className="text-xs text-muted-foreground" data-testid="model-menu-source">
          {view?.menu.source === "settings"
            ? "Configured here"
            : "Automatic groups by provider family"}
        </span>
      </div>

      <div className="space-y-1">
        <Label htmlFor="model-menu-adapter">Gateway catalog</Label>
        <select
          id="model-menu-adapter"
          data-testid="model-menu-adapter"
          value={adapterType ?? ""}
          onChange={(event) => setAdapterType(event.target.value)}
          className="h-9 rounded-md border px-2 text-sm"
        >
          {(view?.adapterTypes ?? []).map((entry) => (
            <option key={entry.type} value={entry.type}>
              {entry.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground" data-testid="model-menu-catalog-size">
          {catalog.length} models in the catalog, {view?.menu.visibleModelIds.length ?? 0} visible
          {view?.menu.hiddenModelIds.length ? `, ${view.menu.hiddenModelIds.length} hidden` : ""}
        </p>
      </div>

      <ul className="space-y-2" data-testid="model-menu-groups">
        {groups.map((group, index) => renderGroup(group, [index]))}
      </ul>

      <Button
        size="sm"
        variant="outline"
        data-testid="model-menu-add-root-group"
        onClick={() => setGroups((current) => [...current, { title: "Новая группа", models: [] }])}
      >
        <Plus className="size-3" /> Group
      </Button>

      <div className="space-y-2">
        <Label>Hidden models</Label>
        <div className="flex flex-wrap gap-3" data-testid="model-menu-hidden">
          {hiddenCandidates.length === 0 && (
            <span className="text-xs text-muted-foreground">The catalog is empty.</span>
          )}
          {hiddenCandidates.map((id) => (
            <label key={id} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={hidden.includes(id)}
                data-testid={`model-menu-hidden-${id}`}
                onChange={(event) =>
                  setHidden((current) =>
                    event.target.checked ? [...current, id] : current.filter((entry) => entry !== id),
                  )
                }
              />
              {id}
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label>The bot shows</Label>
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs" data-testid="model-menu-preview">
          {view ? previewLines(view.menu.groups).join("\n") : "Loading…"}
        </pre>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} data-testid="model-menu-save">
          Save
        </Button>
        <Button
          variant="outline"
          data-testid="model-menu-reset"
          onClick={() => {
            setGroups(draftFrom(view?.stored ?? null));
            setHidden(view?.stored?.hidden ?? []);
            setError(null);
          }}
        >
          Reset
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>

      <p className="text-xs text-muted-foreground">
        Saved to the instance settings and read on every /model — the Telegram menu changes at once,
        without a restart.
      </p>
    </section>
  );
}