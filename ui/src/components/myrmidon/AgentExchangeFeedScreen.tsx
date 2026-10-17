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
              "no participants recorded"}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>
            {formatAgentExchangeRoomStatus(room)} · round {room.currentRound}/{room.maxRounds}
          </div>
          <div>
            {room.tokensUsed.toLocaleString()} tokens · {formatAgentExchangeRoomCost(room)}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        {room.summarized ? (
          <>
            <span className="text-muted-foreground">
              Outcome: <code>{room.summaryDocumentKey}</code>
            </span>
            {room.skillCandidate ? (
              <Link to="/skills/lifecycle" className="text-muted-foreground hover:underline">
                Candidate skill: {room.skillCandidate.name} — waiting for approval
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
                {pending ? "Registering..." : "To skill"}
              </Button>
            ) : (
              <span className="text-muted-foreground">
                The «to skill» button is switched off in the feed settings.
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            No outcome yet — the room has to be finalized before it can become a skill.
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
  return (
    <div className="max-w-4xl space-y-6" data-testid="myrmidon-agent-exchange-feed-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ListVideo className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Agent exchanges</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          What the agents discussed outside the task threads: every room with its outcome, what it cost and the link
          to the task. A useful outcome becomes a skill candidate with one button — the candidate waits for an
          approval before it reaches anyone.
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
        <p className="text-sm text-muted-foreground">Loading the rooms...</p>
      ) : !feed || feed.rooms.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No discussion rooms yet. A room is opened on a task card; its outcome shows up here with what it cost.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground" data-testid="agent-exchange-feed-totals">
            {feed.totals.rooms} rooms · {feed.totals.summarizedRooms} with an outcome · {feed.totals.candidateRooms}{" "}
            candidates · {feed.totals.tokensUsed.toLocaleString()} tokens · $
            {(feed.totals.costCents / 10_000).toFixed(4)}
            {feed.totals.costUnknownRooms > 0
              ? ` · ${feed.totals.costUnknownRooms} with an unknown price`
              : ""}
            {feed.truncated ? ` · showing the newest ${feed.limit}` : ""}
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
        ? `Registered «${mutation.data.result.name}» as a skill candidate. It waits for an approval on the skill lifecycle screen.`
        : `«${mutation.data.result.name}» is already a skill candidate — nothing was created twice.`
      : null;

  return (
    <AgentExchangeFeedScreenView
      feed={query.data}
      loading={query.isLoading}
      error={
        query.isError
          ? query.error instanceof Error
            ? query.error.message
            : "Could not load the agent exchanges."
          : mutation.isError
            ? mutation.error instanceof Error
              ? mutation.error.message
              : "Could not register the skill candidate."
            : null
      }
      pendingRoomId={mutation.isPending ? mutation.variables?.roomId ?? null : null}
      notice={notice}
      onToSkill={(room) => mutation.mutate(room)}
    />
  );
}