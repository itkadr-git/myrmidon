import type { Db } from "@myrmidon/db";
import { issueThreadInteractions } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import type { issueService } from "./issues.js";
import {
  continuationPolicyWakesOnResolution,
  interactionContinuationOutboxService,
} from "../myrmidon/interaction-continuation-outbox.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";

type ProposalResolutionNotification = {
  id?: string | null;
  originIssueId: string | null;
  kind: string;
  proposedName: string | null;
  configPath: string | null;
  interactionId?: string | null;
  continuationPolicy?: string | null;
};

export async function notifySecretProposalResolution(input: {
  proposal: ProposalResolutionNotification;
  status: "approved" | "rejected";
  userId: string;
  reason?: string | null;
  /** Extra line rendered under the status, e.g. what a rotation approval did. */
  resolutionNote?: string | null;
  issues: Pick<ReturnType<typeof issueService>, "getById" | "addComment">;
  heartbeat: IssueAssignmentWakeupDeps;
  db?: Db;
}) {
  if (!input.proposal.originIssueId) return;
  try {
    const issue = await input.issues.getById(input.proposal.originIssueId);
    if (!issue) return;
    const subject = input.proposal.kind === "secret"
      ? `secret proposal \`${input.proposal.proposedName ?? "unnamed"}\``
      : `binding proposal \`${input.proposal.configPath ?? "unknown"}\``;
    const configPath = input.proposal.kind === "binding"
      ? `\n- New config path: \`${input.proposal.configPath ?? "unknown"}\`\n- Verify: \`GET /api/agents/me/secrets\``
      : "";
    const reason = input.reason ? `\n\nReason: ${input.reason}` : "";
    const note = input.resolutionNote ? `\n- ${input.resolutionNote}` : "";
    try {
      await input.issues.addComment(
        issue.id,
        `Secret proposal resolution\n\n- Proposal: ${subject}\n- Status: **${input.status}**${configPath}${note}${reason}`,
        { userId: input.userId },
      );
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id, proposalStatus: input.status },
        "failed to post secret proposal resolution comment",
      );
    }

    const resolutionStatus = input.status === "approved" ? "accepted" : "rejected";
    let shouldWake = true;
    const interactionId = input.proposal.interactionId ?? null;

    if (input.proposal.continuationPolicy !== undefined) {
      shouldWake = continuationPolicyWakesOnResolution(
        input.proposal.continuationPolicy,
        resolutionStatus,
      );
    } else if (input.db && interactionId) {
      const interaction = await input.db
        .select({
          id: issueThreadInteractions.id,
          continuationPolicy: issueThreadInteractions.continuationPolicy,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);
      if (interaction) {
        shouldWake = continuationPolicyWakesOnResolution(
          interaction.continuationPolicy,
          resolutionStatus,
        );
      }
    }

    if (!shouldWake) return;

    const wakeIdempotencyKey = interactionId
      ? `interaction:${interactionId}:${resolutionStatus}`
      : `secret-proposal-resolution:${input.proposal.id ?? issue.id}:${input.status}`;

    await queueIssueAssignmentWakeup({
      heartbeat: input.heartbeat,
      issue,
      reason: "secret_proposal_resolved",
      mutation: `secret_proposal_${input.status}`,
      contextSource: "secret.proposal.resolution",
      requestedByActorType: "user",
      requestedByActorId: input.userId,
      idempotencyKey: wakeIdempotencyKey,
    });

    if (input.db && interactionId) {
      await interactionContinuationOutboxService(input.db, input.heartbeat)
        .tryDeliver(interactionId, resolutionStatus)
        .catch((err) => {
          logger.warn(
            { err, interactionId, resolutionStatus },
            "failed to settle interaction continuation outbox after secret proposal resolution",
          );
        });
    }
  } catch (err) {
    logger.warn(
      { err, issueId: input.proposal.originIssueId, proposalStatus: input.status },
      "failed to notify origin issue about secret proposal resolution",
    );
  }
}
