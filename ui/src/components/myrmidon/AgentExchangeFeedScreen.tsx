// The owner-facing feed of agent discussion rooms (myrmidon 1.7
// AGENT-EXCHANGE-B).
//
// A screen of the CURRENT interface (the 2.0 screens wait for OPE-3923): the
// owner sees what the agents discussed outside the task threads — every room
// with its outcome, its price tag and the link back to the task — and turns a
// useful outcome into a skill candidate with one button.
//
// The button never promotes anything: the candidate lands in the skill
// library as a candidate and waits for an approval on the skills screen.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { ListVideo, Sparkles } from "lucide-react";
import type { AgentExchangeFeedResponse, AgentExchangeFeedRoom } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import {
  agentExchangeFeedApi,
  agentExchangeFeedQueryKey,
  formatAgentExchangeRoomCost,
  formatAgentExchangeRoomLabel,
  formatAgentExchangeRoomStatus,
} from "./agentExchangeFeedApi";

/** The camera of one room: who answered, how far it got, what it cost. */
function RoomRow({
  room,
  onToSkill,
  pending,
  skillCandidateEnabled,
}: {
  room: AgentExchangeFeedRoom;
  onToSkill: (room: AgentExchangeFeedRoom) => void;
  pending: boolean;
  skillCandidateEnabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="space-y-2 border-b border-border px-4 py-3 last:border-b-0"
      data-testid="agent-exchange-feed-room"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Link to={`/issues/${room.issueId}`} className="text-sm font-medium hover:underline">
            {formatAgentExchangeRoomLabel(room)}
          </Link>
          <div className="text-xs text-muted-foreground">
            {room.participants.map((participant) => `${participant.label} (${participant.model})`).join(", ") ||
              t("area.settings-integrations.agent-exchange-feed-screen.noParticipants")}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>
            {formatAgentExchangeRoomStatus(room)} ·{" "}
            {t("area.settings-integrations.agent-exchange-feed-screen.roundProgress", { current: room.currentRound, max: room.maxRounds })}
          </div>
          <div>
            {t("area.settings-integrations.agent-exchange-feed-screen.tokensAndCost", {
              tokens: room.tokensUsed.toLocaleString(),
              cost: formatAgentExchangeRoomCost(room),
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        {room.summarized ? (
          <>
            <span className="text-muted-foreground">
              {t("area.settings-integrations.agent-exchange-feed-screen.outcome")} <code>{room.summaryDocumentKey}</code>
            </span>
            {room.skillCandidate ? (
              <Link to="/skills/lifecycle" className="text-muted-foreground hover:underline">
                {t("area.settings-integrations.agent-exchange-feed-screen.candidateSkill", { name: room.skillCandidate.name })}
              </Link>
            ) : skillCandidateEnabled ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                data-testid="agent-exchange-feed-to-skill"
                onClick={() => onToSkill(room)}
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {pending ? t("area.settings-integrations.agent-exchange-feed-screen.registering") : t("area.settings-integrations.agent-exchange-feed-screen.toSkill")}
              </Button>
            ) : (
              <span className="text-muted-foreground">
                {t("area.settings-integrations.agent-exchange-feed-screen.toSkillOff")}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            {t("area.settings-integrations.agent-exchange-feed-screen.noOutcome")}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentExchangeFeedScreenView({
  feed,
  loading,
  error,
  onToSkill,
  pendingRoomId,
  notice,
}: {
  feed: AgentExchangeFeedResponse | null | undefined;
  loading: boolean;
  error: string | null;
  onToSkill: (room: AgentExchangeFeedRoom) => void;
  pendingRoomId: string | null;
  notice: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-4xl space-y-6" data-testid="myrmidon-agent-exchange-feed-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ListVideo className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("area.settings-integrations.agent-exchange-feed-screen.title")}</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-integrations.agent-exchange-feed-screen.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{notice}</div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("area.settings-integrations.agent-exchange-feed-screen.loading")}</p>
      ) : !feed || feed.rooms.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("area.settings-integrations.agent-exchange-feed-screen.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground" data-testid="agent-exchange-feed-totals">
            {t("area.settings-integrations.agent-exchange-feed-screen.totals", {
              rooms: feed.totals.rooms,
              summarized: feed.totals.summarizedRooms,
              candidates: feed.totals.candidateRooms,
              tokens: feed.totals.tokensUsed.toLocaleString(),
              cost: (feed.totals.costCents / 10_000).toFixed(4),
            })}
            {feed.totals.costUnknownRooms > 0
              ? ` · ${t("area.settings-integrations.agent-exchange-feed-screen.unknownPrice", { count: feed.totals.costUnknownRooms })}`
              : ""}
            {feed.truncated ? ` · ${t("area.settings-integrations.agent-exchange-feed-screen.showingNewest", { limit: feed.limit })}` : ""}
          </div>
          <div className="rounded-md border border-border">
            {feed.rooms.map((room) => (
              <RoomRow
                key={room.roomId}
                room={room}
                onToSkill={onToSkill}
                pending={pendingRoomId === room.roomId}
                skillCandidateEnabled={feed.skillCandidateEnabled}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentExchangeFeedScreen() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: agentExchangeFeedQueryKey(selectedCompanyId ?? "none"),
    queryFn: () => agentExchangeFeedApi.feed(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const mutation = useMutation({
    mutationFn: (room: AgentExchangeFeedRoom) =>
      agentExchangeFeedApi.createSkillCandidate(selectedCompanyId!, room.roomId).then((result) => ({ result, room })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentExchangeFeedQueryKey(selectedCompanyId ?? "none") });
      void queryClient.invalidateQueries({ queryKey: ["myrmidon", "skill-lifecycle"] });
      void queryClient.invalidateQueries({ queryKey: ["company-skills"] });
    },
  });

  const notice =
    mutation.isSuccess && mutation.data
      ? mutation.data.result.created
        ? t("area.settings-integrations.agent-exchange-feed-screen.registered", { name: mutation.data.result.name })
        : t("area.settings-integrations.agent-exchange-feed-screen.alreadyCandidate", { name: mutation.data.result.name })
      : null;

  return (
    <AgentExchangeFeedScreenView
      feed={query.data}
      loading={query.isLoading}
      error={
        query.isError
          ? query.error instanceof Error
            ? query.error.message
            : t("area.settings-integrations.agent-exchange-feed-screen.loadError")
          : mutation.isError
            ? mutation.error instanceof Error
              ? mutation.error.message
              : t("area.settings-integrations.agent-exchange-feed-screen.registerError")
            : null
      }
      pendingRoomId={mutation.isPending ? mutation.variables?.roomId ?? null : null}
      notice={notice}
      onToSkill={(room) => mutation.mutate(room)}
    />
  );
}