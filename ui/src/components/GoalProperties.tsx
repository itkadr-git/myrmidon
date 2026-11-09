import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@myrmidon/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@myrmidon/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

function PickerButton({
  current,
  options,
  getLabel,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  getLabel: (value: string) => string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {getLabel(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const statusLabels: Record<string, string> = {
    planned: t("area.projects-goals-workspaces-1.goal-properties.statusPlanned"),
    active: t("area.projects-goals-workspaces-1.goal-properties.statusActive"),
    achieved: t("area.projects-goals-workspaces-1.goal-properties.statusAchieved"),
    cancelled: t("area.projects-goals-workspaces-1.goal-properties.statusCancelled"),
  };
  const levelLabels: Record<string, string> = {
    company: t("area.projects-goals-workspaces-1.goal-properties.levelCompany"),
    team: t("area.projects-goals-workspaces-1.goal-properties.levelTeam"),
    agent: t("area.projects-goals-workspaces-1.goal-properties.levelAgent"),
    task: t("area.projects-goals-workspaces-1.goal-properties.levelTask"),
  };
  const statusLabel = (value: string) => statusLabels[value] ?? value;
  const levelLabel = (value: string) => levelLabels[value] ?? value;

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label={t("area.projects-goals-workspaces-1.goal-properties.status")}>
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              getLabel={statusLabel}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label={t("area.projects-goals-workspaces-1.goal-properties.level")}>
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              getLabel={levelLabel}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm">{levelLabel(goal.level)}</span>
            </PickerButton>
          ) : (
            <span className="text-sm">{levelLabel(goal.level)}</span>
          )}
        </PropertyRow>

        <PropertyRow label={t("area.projects-goals-workspaces-1.goal-properties.owner")}>
          {ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">{t("common.none")}</span>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label={t("area.projects-goals-workspaces-1.goal-properties.parentGoal")}>
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label={t("area.projects-goals-workspaces-1.goal-properties.created")}>
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={t("area.projects-goals-workspaces-1.goal-properties.updated")}>
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
