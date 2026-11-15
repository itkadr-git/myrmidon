// myrmidon(1.6.8 OPE-12709): "model unavailable since HH:MM" mark on an agent.
//
// The server derives it from the same state as the ROLE_MODEL_DOWN attention
// card (Agent.roleModelDownSince = time of the first model refusal while the
// role has no successful run). It renders nothing for a healthy role, and the
// time is shown in the viewer's local time zone. Tokens only (DESIGN.md).
import { useTranslation } from "@/i18n";

export function formatLocalHHMM(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function RoleModelDownBadge({ since, agentId }: { since?: string | null; agentId?: string }) {
  const { t } = useTranslation();
  const time = since ? formatLocalHHMM(since) : null;
  if (!time) return null;
  return (
    <span
      data-testid={agentId ? `agent-role-model-down-${agentId}` : "agent-role-model-down"}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap bg-destructive/10 text-destructive"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden />
      <span>{t("agents.roleModelDownSince", { time })}</span>
    </span>
  );
}
