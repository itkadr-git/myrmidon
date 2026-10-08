// myrmidon(OPE-6011): verifies that a wake's comment is a person's
// @-mention of the woken agent — the one case where `isExplicitWake`
// treats a wake that *carries* a comment as explicitly authorized
// (wake-classification.ts, `userCommentMentionsWokenAgent`).
//
// The classifier only trusts a boolean the caller computed; this module is
// where the caller gets that boolean from data it cannot fake: the comment
// row itself. A wake passes when, and only when, all of the following hold
// against the live row:
//   - the comment exists, belongs to the issue the wake is for, and has a
//     human author (`authorUserId`, no `authorAgentId` — an agent's comment
//     never authorizes a hold bypass, per the round-1 fix);
//   - the comment's body @-mentions the woken agent (the assignee the
//     message addresses);
//   - the wake's `requestedByActorId` is that author — the person who
//     asked for the wake is the person who wrote the mention.
//
// Anything else — an agent's comment, a person's comment without a
// mention, a mention of a different agent, a deleted comment — returns
// false and the wake keeps the safe not-explicit default.

import { and, eq } from "drizzle-orm";
import { issueComments } from "@paperclipai/db";
import { extractAgentMentionIds } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";

export async function userCommentMentionsWokenAgent(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    commentId: string;
    requestedByActorType?: "user" | "agent" | "system" | null;
    requestedByActorId?: string | null;
  },
): Promise<boolean> {
  if (input.requestedByActorType !== "user") return false;
  if (!input.requestedByActorId) return false;
  const [comment] = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, input.commentId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!comment) return false;
  if (!comment.authorUserId || comment.authorAgentId) return false;
  if (comment.authorUserId !== input.requestedByActorId) return false;
  return extractAgentMentionIds(comment.body ?? "").includes(input.agentId);
}
