import { useState } from "react";
import { useTranslation } from "@/i18n";
import type { Agent } from "@myrmidon/shared";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";

export interface AgentChatPickerProps {
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (agent: Agent) => void;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}

export function AgentChatPicker({ open, onOpenChange, ...props }: AgentChatPickerProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="px-4 pt-4 pb-3">
          <DialogTitle>{t("area.agents-1.agent-chat-picker.title")}</DialogTitle>
        </div>
        {/* The dialog unmounts its content on close, so each search starts empty. */}
        <AgentChatPickerResults {...props} onSelect={(agent) => {
          onOpenChange(false);
          props.onSelect(agent);
        }} />
      </DialogContent>
    </Dialog>
  );
}

function AgentChatPickerResults({ agents, onSelect, loading, error, onRetry }: Omit<AgentChatPickerProps, "open" | "onOpenChange">) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  return (
    <Command>
      <CommandInput
        aria-label={t("area.agents-1.agent-chat-picker.searchAria")}
        placeholder={t("area.agents-1.agent-chat-picker.searchPlaceholder")}
        value={search}
        onValueChange={setSearch}
      />
      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
          <p>{t("area.agents-1.agent-chat-picker.loadError")}</p>
          {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t("common.retry")}</Button>}
        </div>
      ) : loading ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">{t("area.agents-1.agent-chat-picker.loading")}</p>
      ) : (
        <CommandList>
          <CommandEmpty>
            <div className="flex flex-col items-center gap-2 px-4">
              <span>{agents.length ? t("area.agents-1.agent-chat-picker.noMatch", { search }) : t("area.agents-1.agent-chat-picker.noAgents")}</span>
              {agents.length ? <>
                <span className="text-xs text-muted-foreground">{t("area.agents-1.agent-chat-picker.tryAnother")}</span>
                <Button variant="ghost" size="sm" onClick={() => setSearch("")}>{t("area.agents-1.agent-chat-picker.clearSearch")}</Button>
              </> : <span className="text-xs text-muted-foreground">{t("area.agents-1.agent-chat-picker.createHint")}</span>}
            </div>
          </CommandEmpty>
          <CommandGroup>
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={agent.id}
                keywords={[agent.name, agent.title ?? "", agent.role]}
                onSelect={() => onSelect(agent)}
                className="gap-3 px-3 py-3"
              >
                <AgentIcon icon={agent.icon} className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</span>
                </span>
                {agent.status === "paused" && <span className="text-xs text-(--status-agent-paused)">{t("status.paused")}</span>}
                {agent.status === "terminated" && <span className="text-xs text-muted-foreground">{t("area.agents-1.agent-chat-picker.terminated")}</span>}
                {agent.status === "pending_approval" && <span className="text-xs text-muted-foreground">{t("area.agents-1.agent-chat-picker.awaitingApproval")}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      )}
    </Command>
  );
}
