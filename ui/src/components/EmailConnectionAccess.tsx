import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@myrmidon/shared";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { useTranslation } from "@/i18n";

export function EmailConnectionAccess({
  companyId,
  connectionId,
  agents,
}: {
  companyId: string;
  connectionId: string;
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const grants = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connectionId),
    queryFn: () => toolsApi.listConnectionGrants(connectionId),
  });
  const installs = useQuery({
    queryKey: queryKeys.tools.connectionInstalls(connectionId),
    queryFn: () => toolsApi.getConnectionInstalls(connectionId),
  });
  const save = useMutation({
    mutationFn: (
      next: Array<{ targetType: "company" | "agent"; targetId: string }>,
    ) => toolsApi.putConnectionInstalls(connectionId, next),
    onSuccess: () => {
      void cache.invalidateQueries({
        queryKey: queryKeys.tools.connectionInstalls(connectionId),
      });
    },
  });
  if (grants.isLoading || installs.isLoading)
    return <p className="text-sm text-muted-foreground">{t("area.apps-chat-email.email-connection-access.loading")}</p>;
  if (grants.error || installs.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("area.apps-chat-email.email-connection-access.loadFailed")}
      </p>
    );
  const active = grants.data?.grants.filter((g) => g.status === "active") ?? [];
  const everyone = active.some((g) => g.kind === "organization");
  const personal = active.find((g) => g.kind === "user");
  const humanLabel = everyone
    ? t("area.apps-chat-email.email-connection-access.humanEveryone")
    : personal
      ? personal.subjectUserId === grants.data?.currentUserId
        ? t("area.apps-chat-email.email-connection-access.humanJustMe")
        : t("area.apps-chat-email.email-connection-access.humanOwnerOnly")
      : t("area.apps-chat-email.email-connection-access.humanRevoked");
  const allAgents =
    installs.data?.installs.some((i) => i.targetType === "company") ?? false;
  const selected = new Set(
    installs.data?.installs
      .filter((i) => i.targetType === "agent")
      .map((i) => i.targetId),
  );
  const disabled = !grants.data?.capabilities.canConfigure || save.isPending;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("area.apps-chat-email.email-connection-access.humansTitle")}
        </h2>
        <p className="text-sm">{humanLabel}</p>
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">
          {t("area.apps-chat-email.email-connection-access.agentsTitle")}
        </h2>
        <RadioCardGroup
          ariaLabel={t("area.apps-chat-email.email-connection-access.agentsAriaLabel")}
          value={allAgents ? "all" : "selected"}
          disabled={disabled}
          className="sm:grid-cols-2"
          options={[
            { value: "selected", title: t("area.apps-chat-email.email-connection-access.agentsSelected") },
            { value: "all", title: t("area.apps-chat-email.email-connection-access.agentsAll") },
          ]}
          onValueChange={(value) =>
            save.mutate(
              value === "all"
                ? [{ targetType: "company", targetId: companyId }]
                : Array.from(selected, (targetId) => ({
                    targetType: "agent",
                    targetId,
                  })),
            )
          }
        />
        {!allAgents && (
          <AgentMultiSelect
            agents={agents.filter((a) => a.status !== "terminated")}
            selectedAgentIds={selected}
            disabled={disabled}
            onSave={(ids) =>
              save.mutate(
                Array.from(ids, (targetId) => ({
                  targetType: "agent",
                  targetId,
                })),
              )
            }
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t("area.apps-chat-email.email-connection-access.removeNote")}
        </p>
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
      </section>
    </div>
  );
}
