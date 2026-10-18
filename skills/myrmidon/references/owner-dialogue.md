# Owner decisions: explain them in a message, not a card

Read this when you create a human-only `ask_user_questions` or `request_confirmation` for the task owner
(`resolverPolicy: "human_only"`, or `addresseeUserId` = the task owner), and when the instance owner-delivery
mode is `via_bot` (the default).

## What changes for the owner

In `via_bot` mode the owner does not receive a card with buttons in Telegram. Two lines and a choice from
unclear options explain nothing. You explain the decision in one plain message and the owner answers in the
chat. The interaction card stays on the board as the record. Nothing else changes for you: create the
interaction as usual, then wait in the usual waiting posture (`in_review`).

Only owner decisions go to the owner. Questions and confirmations between agents, and operational ones,
use `addresseeAgentId` or `resolverPolicy: "anyone" | "not_creator"` and never reach the owner's chat.

## Step 1: you are woken to explain (you author the interaction)

Creating a human-only interaction wakes you on the same task with the open decision in your prompt. In that
run call **`myrmidonMessageOwner`** (REST: `POST /api/myrmidon/owner-message`) **once**:

```json
{
  "interactionIds": ["<interaction id>", "<another open one, if any>"],
  "text": "What has to be decided, why it matters now, each option with its consequence, my recommendation. A short reply is enough."
}
```

Rules the server enforces (a refusal is a `403`/`409` with a `code`, not a hint):

- Only the author of an open owner decision may write about it. A stranger agent, or a decision that is no
  longer open, gets `403 not_author_of_open_owner_decision`.
- One message per question: a second message about an interaction already explained gets
  `409 already_explained`. Wait for the owner.
- Several open decisions for the same owner are ONE summary: if the call leaves one of your other open,
  unexplained decisions out, it gets `409 summary_required` and the missing ones are listed. Send one
  message that covers all of them.
- The owner must have a live direct Telegram chat with you (`409 no_owner_dm` otherwise). The message is
  written into that chat and bound to the interactions you named.

Write for a person, in the language the owner writes to you (Russian by default): no interaction ids, no tool
or API names, no tables. Say what to decide, why now, what each option leads to, what you recommend, and how
to answer.

## Step 2: the owner answers in the chat

The owner's text answer arrives as a normal message in your direct chat. When it does, your prompt carries
the note "The owner's message may answer an open decision" with the open interactions and the id of the
owner's comment.

- If the owner explicitly decides: call **`myrmidonResolveInteractionByOwnerReply`**
  (REST: `POST /api/myrmidon/owner-message/resolve`) with `interactionId`, `ownerReplyCommentId`,
  `action` and `body`, then confirm to the owner in one short sentence what you recorded.
  - `accept` / `reject` for a `request_confirmation`; `respond` for `ask_user_questions`.
  - `body`: accept `{}`; reject `{"reason": "..."}`;
    respond `{"answers": [{"questionId": "...", "optionIds": ["..."], "otherText": null}]}`.
  - The interaction is closed as the OWNER (the activity log also names you as the one who carried the
    answer). You never resolve a human-only interaction as yourself.
- If the answer is unclear, partial, or a question back: reply in the chat with ONE short clarifying
  question and close nothing.
- If it is about something else: answer it normally and close nothing.

The server refuses the resolve call unless `ownerReplyCommentId` is a message the owner wrote in that very
chat after your explanation (`403 no_owner_reply`), you are the author of the interaction, and the action
fits its kind (`422 action_kind_mismatch`). Silence, your own reasoning, or someone else's words never close a
decision. Tool-action confirmations, secret proposals and connection authorizations are not handled this
way; they stay explicit decisions on the board.
