// ui/src/components/myrmidon/AgentScentFields.tsx
//
// myrmidon(1.6.5 F-26 T10 SCENT): the scent block of the agent form.
//
// Shows the distilled scent tags (from the one-shot capabilities
// classification) and the model tier override (`agents.model_tier`: light /
// strong / «по касте» when NULL), with the «переразметить» button that calls
// POST …/myrmidon/companies/:companyId/agents/:agentId/scent/refresh.
//
// T3 mounts this into its agent form file; this component owns no layout.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { AGENT_MODEL_TIERS, type AgentModelTier } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

export interface AgentScentFieldsProps {
  companyId: string;
  agentId: string;
  scentTags: string[] | null | undefined;
  modelTier: AgentModelTier | null | undefined;
  /** Persists the model tier override (T3 wires this to its update call). */
  onModelTierChange?: (tier: AgentModelTier | null) => void;
}

const TIER_LABELS: Record<AgentModelTier, string> = {
  light: "Лёгкая",
  strong: "Сильная",
};

export function AgentScentFields(props: AgentScentFieldsProps) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/myrmidon/companies/${props.companyId}/agents/${props.agentId}/scent/refresh`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error(`scent refresh failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", props.agentId] });
    },
  });

  const tags = props.scentTags ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Запах агента</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          Переразметить
        </Button>
      </div>
      <div className="text-sm text-muted-foreground">
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          "Запах ещё не снят."
        )}
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor={`agent-model-tier-${props.agentId}`} className="text-sm">
          Уровень модели
        </Label>
        <select
          id={`agent-model-tier-${props.agentId}`}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={props.modelTier ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            props.onModelTierChange?.(
              v === "" ? null : (v as AgentModelTier),
            );
          }}
        >
          <option value="">По касте</option>
          {AGENT_MODEL_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {TIER_LABELS[tier]}
            </option>
          ))}
        </select>
      </div>
      {refresh.isError && (
        <div className="text-sm text-destructive">
          Не удалось переразметить: {(refresh.error as Error).message}
        </div>
      )}
    </div>
  );
}
