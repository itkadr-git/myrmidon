import { useState, useMemo, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Check,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wand2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  findFallbackTopologyCycles,
  findUnknownModelGroups,
  sortFallbackTargets,
  validateFallbackDiversity,
  validateFallbackOrder,
  type FallbackChain,
  type KnownModelInfo,
} from "@myrmidon/shared";
import {
  litellmFallbacksKey,
  litellmKeysApi,
  type GatewayFallbackCycle,
  type GatewayFallbackModelInfo,
} from "./litellmKeysApi";

interface GatewayFallbacksEditorProps {
  companyId: string;
  initialChains: FallbackChain[];
  cycles: GatewayFallbackCycle[];
  knownModels?: GatewayFallbackModelInfo[];
}

export function GatewayFallbacksEditor({
  companyId,
  initialChains,
  cycles: initialCycles,
  knownModels = [],
}: GatewayFallbacksEditorProps) {
  const queryClient = useQueryClient();
  const [chains, setChains] = useState<FallbackChain[]>(() => initialChains);
  const [isDirty, setIsDirty] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [targetInputs, setTargetInputs] = useState<Record<string, string>>({});
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setChains(initialChains);
    setIsDirty(false);
  }, [initialChains]);

  const modelCatalog = useMemo(() => {
    const map = new Map<string, KnownModelInfo>();
    for (const m of knownModels) {
      map.set(m.modelName, {
        modelName: m.modelName,
        provider: m.provider,
        inputCostPerToken: m.inputCostPerToken,
        outputCostPerToken: m.outputCostPerToken,
        isFree: m.isFree,
      });
    }
    return map;
  }, [knownModels]);

  const knownNamesSet = useMemo(() => {
    return new Set(knownModels.map((m) => m.modelName));
  }, [knownModels]);

  const activeCycles = useMemo(() => {
    return findFallbackTopologyCycles(chains);
  }, [chains]);

  const unknownGroups = useMemo(() => {
    return findUnknownModelGroups(chains, knownNamesSet);
  }, [chains, knownNamesSet]);

  const mutation = useMutation({
    mutationFn: (updatedChains: FallbackChain[]) =>
      litellmKeysApi.updateFallbacks(companyId, updatedChains),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: litellmFallbacksKey(companyId) });
      setIsDirty(false);
      setStatusMessage({ type: "success", text: "Fallback topology successfully saved to LiteLLM /config/update and database." });
    },
    onError: (err: Error) => {
      setStatusMessage({ type: "error", text: err.message || "Failed to save fallback chains." });
    },
  });

  const handleAddChain = () => {
    const trimmed = newModelName.trim();
    if (!trimmed) return;
    if (chains.some((c) => c.model === trimmed)) {
      setStatusMessage({ type: "error", text: `Chain for model group '${trimmed}' already exists.` });
      return;
    }
    setChains([...chains, { model: trimmed, targets: [] }]);
    setNewModelName("");
    setIsDirty(true);
    setStatusMessage(null);
  };

  const handleDeleteChain = (model: string) => {
    setChains(chains.filter((c) => c.model !== model));
    setIsDirty(true);
    setStatusMessage(null);
  };

  const handleAddTarget = (model: string) => {
    const inputVal = (targetInputs[model] ?? "").trim();
    if (!inputVal) return;
    setChains(
      chains.map((chain) => {
        if (chain.model !== model) return chain;
        if (chain.targets.includes(inputVal)) return chain;
        return { ...chain, targets: [...chain.targets, inputVal] };
      }),
    );
    setTargetInputs({ ...targetInputs, [model]: "" });
    setIsDirty(true);
    setStatusMessage(null);
  };

  const handleRemoveTarget = (model: string, index: number) => {
    setChains(
      chains.map((chain) => {
        if (chain.model !== model) return chain;
        const newTargets = [...chain.targets];
        newTargets.splice(index, 1);
        return { ...chain, targets: newTargets };
      }),
    );
    setIsDirty(true);
    setStatusMessage(null);
  };

  const handleMoveTarget = (model: string, index: number, direction: "up" | "down") => {
    setChains(
      chains.map((chain) => {
        if (chain.model !== model) return chain;
        const newTargets = [...chain.targets];
        const swapIdx = direction === "up" ? index - 1 : index + 1;
        if (swapIdx < 0 || swapIdx >= newTargets.length) return chain;
        const temp = newTargets[index]!;
        newTargets[index] = newTargets[swapIdx]!;
        newTargets[swapIdx] = temp;
        return { ...chain, targets: newTargets };
      }),
    );
    setIsDirty(true);
    setStatusMessage(null);
  };

  const handleAutoOrder = (model: string) => {
    setChains(
      chains.map((chain) => {
        if (chain.model !== model) return chain;
        const sorted = sortFallbackTargets(chain.targets, chain.model, modelCatalog);
        return { ...chain, targets: sorted };
      }),
    );
    setIsDirty(true);
    setStatusMessage(null);
  };

  const handleReset = () => {
    setChains(initialChains);
    setIsDirty(false);
    setStatusMessage(null);
  };

  const handleSave = () => {
    setStatusMessage(null);
    mutation.mutate(chains);
  };

  return (
    <div className="space-y-4 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="text-xs text-muted-foreground">
          Source of truth: <span className="font-semibold text-foreground">LiteLLM DB & /config/update</span>
          {" "}({chains.length} configured groups)
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Button size="xs" variant="ghost" onClick={handleReset} disabled={mutation.isPending}>
              <RefreshCw className="size-3" />
              Reset
            </Button>
          )}
          <Button
            size="xs"
            variant="default"
            onClick={handleSave}
            disabled={!isDirty || mutation.isPending || activeCycles.length > 0}
          >
            <Save className="size-3" />
            {mutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>

      {statusMessage && (
        <div
          className={`flex items-center gap-2 rounded-md p-3 text-xs ${
            statusMessage.type === "success"
              ? "bg-secondary text-secondary-foreground"
              : "border border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {statusMessage.type === "success" ? <Check className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {activeCycles.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Cycle detected in topology! Saving is disabled until cycles are resolved:</span>
          </div>
          <ul className="mt-1.5 list-inside list-disc space-y-0.5">
            {activeCycles.map((c, idx) => (
              <li key={idx} className="font-mono">
                {[...c.path, c.path[0]].join(" → ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknownGroups.length > 0 && (
        <div className="rounded-md border border-border bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            <span>Unknown model groups ({unknownGroups.length}) not present in LiteLLM catalog:</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {unknownGroups.map((group) => (
              <Badge key={group} variant="outline" className="text-xs">
                {group}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {chains.map((chain) => {
          const diversity = validateFallbackDiversity(chain, modelCatalog);
          const orderValidation = validateFallbackOrder(chain, modelCatalog);
          const primaryInfo = modelCatalog.get(chain.model);
          const isPrimaryUnknown = !knownNamesSet.has(chain.model);

          return (
            <div
              key={chain.model}
              className="space-y-2 rounded-md border border-border bg-card p-3 shadow-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs font-semibold">{chain.model}</span>
                  {primaryInfo?.provider && (
                    <Badge variant="secondary" className="text-xs">
                      {primaryInfo.provider}
                    </Badge>
                  )}
                  {primaryInfo?.isFree && (
                    <Badge variant="outline" className="text-xs text-green-600 dark:text-green-400">
                      Free
                    </Badge>
                  )}
                  {isPrimaryUnknown && (
                    <Badge variant="destructive" className="text-xs">
                      Unknown Group
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {chain.targets.length > 1 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleAutoOrder(chain.model)}
                      title="Sort targets: free first, then cheap on different provider"
                    >
                      <Wand2 className="size-3" />
                      Auto-order
                    </Button>
                  )}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => handleDeleteChain(chain.model)}
                    title="Delete chain"
                  >
                    <Trash2 className="size-3 text-destructive" />
                  </Button>
                </div>
              </div>

              {!diversity.valid && (
                <div className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>{diversity.error}</span>
                </div>
              )}

              {!orderValidation.valid && (
                <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>{orderValidation.warning}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Fallback Chain:
                </div>
                {chain.targets.length === 0 ? (
                  <div className="text-xs italic text-muted-foreground">
                    No fallbacks configured (single point of failure).
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{chain.model}</span>
                    {chain.targets.map((target, idx) => {
                      const targetInfo = modelCatalog.get(target);
                      const isTargetUnknown = !knownNamesSet.has(target);

                      return (
                        <div key={idx} className="flex items-center gap-1">
                          <ArrowRight className="size-3 text-muted-foreground shrink-0" />
                          <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs">
                            <span className="font-mono">{target}</span>
                            {targetInfo?.provider && (
                              <Badge variant="outline" className="text-xs">
                                {targetInfo.provider}
                              </Badge>
                            )}
                            {targetInfo?.isFree && (
                              <Badge variant="secondary" className="text-xs text-green-600 dark:text-green-400">
                                Free
                              </Badge>
                            )}
                            {isTargetUnknown && (
                              <Badge variant="destructive" className="text-xs">
                                Unknown
                              </Badge>
                            )}
                            <div className="ml-1 flex items-center">
                              <button
                                type="button"
                                className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                                disabled={idx === 0}
                                onClick={() => handleMoveTarget(chain.model, idx, "up")}
                                title="Move up"
                              >
                                <ArrowUp className="size-3" />
                              </button>
                              <button
                                type="button"
                                className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                                disabled={idx === chain.targets.length - 1}
                                onClick={() => handleMoveTarget(chain.model, idx, "down")}
                                title="Move down"
                              >
                                <ArrowDown className="size-3" />
                              </button>
                              <button
                                type="button"
                                className="rounded-xs p-0.5 text-muted-foreground hover:text-destructive"
                                onClick={() => handleRemoveTarget(chain.model, idx)}
                                title="Remove target"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Input
                  className="h-7 text-xs"
                  placeholder="Add fallback target model/group..."
                  value={targetInputs[chain.model] ?? ""}
                  onChange={(e) => setTargetInputs({ ...targetInputs, [chain.model]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTarget(chain.model);
                    }
                  }}
                />
                <Button size="xs" variant="secondary" onClick={() => handleAddTarget(chain.model)}>
                  <Plus className="size-3" />
                  Add
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2.5">
        <Input
          className="h-8 text-xs"
          placeholder="New model group name (e.g. gpt-4o, zephyr-beta)..."
          value={newModelName}
          onChange={(e) => setNewModelName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddChain();
            }
          }}
        />
        <Button size="sm" variant="secondary" onClick={handleAddChain}>
          <Plus className="size-4" />
          Add Model Group
        </Button>
      </div>
    </div>
  );
}
