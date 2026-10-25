# Owner decisions: explain them in a message, not a card

Read this when you create a human-only `ask_user_questions` or `request_confirmation` for the task owner
(`resolverPolicy: "human_only"`, or `addresseeUserId` = the task owner), and when the instance owner-delivery
mode is `via_bot` (the default).

## What changes for the owner

In `via_bot` mode the owner does not receive a card with buttons in Telegram. Two lines and a choice from
unclear options explain nothing. You explain the decision in one plain message and the owner answers in the
chat. The interaction card stays on the board as the record. Nothing else changes for you: create the
interaction as usual, then wait in the usual waiting posture (`in_review`).

Only owner decisions go to the owner's chat. Questions and confirmations between agents, and operational ones,
use `addresseeAgentId` or `resolverPolicy: "anyone" | "not_creator"` and never reach the owner's chat.

## Step 1: explain the decision once

Use a transport actually exposed in this run. If `myrmidonMessageOwner` is present in the current tool catalog,
call it once with every open, unexplained owner decision you authored. Do not retry by guessing tool names if it
is absent. Use the documented REST fallback only when your runtime provides the authenticated Paperclip API
base URL, API key, and current run ID:

```sh
curl -sS -X POST "$MYRMIDON_API_URL/api/myrmidon/owner-message" \
  -H "Authorization: Bearer $MYRMIDON_API_KEY" \
  -H "X-Paperclip-Run-Id: $MYRMIDON_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data '{"interactionIds":["<interaction-id>"],"text":"<plain-language explanation>"}'
```

The method is `POST` and the exact path is `/api/myrmidon/owner-message` (not an issue interaction URL).
Save the JSON response and its `publicationId`:

```sh
response="$(curl -sS -X POST "$MYRMIDON_API_URL/api/myrmidon/owner-message" \\
  -H "Authorization: Bearer $MYRMIDON_API_KEY" \\
  -H "X-Paperclip-Run-Id: $MYRMIDON_RUN_ID" \\
  -H 'Content-Type: application/json' \\
  --data '{"interactionIds":["<interaction-id>"],"text":"<plain-language explanation>"}')"
printf '%s\n' "$response"
publication_id="$(printf '%s' "$response" | jq -r '.publicationId')"
```

The owner-message response intentionally returns `publicationId` but not `endpointId` or `conversationId`.
The current agent transport has no supported read endpoint that resolves those two IDs. Do not guess them.
The operator must perform the read-back with board access: first resolve the binding for the task, then query
its publication status (replace `<task-id>` and `<publication-id>` literally):

```sh
binding="$(curl -sS "$MYRMIDON_API_URL/api/issues/<task-id>/chat-binding" \\
  -H "Authorization: Bearer $MYRMIDON_API_KEY")"
endpoint_id="$(printf '%s' "$binding" | jq -r '.endpointId')"
conversation_id="$(printf '%s' "$binding" | jq -r '.conversationId')"
curl -sS "$MYRMIDON_API_URL/api/chat-endpoints/$endpoint_id/conversations/$conversation_id/publications/<publication-id>/status" \\
  -H "Authorization: Bearer $MYRMIDON_API_KEY"
```

Use the same run's identity for the POST; never borrow another agent's key or impersonate the owner. The
binding lookup and status GET may require the operator's board-authorized key because the owner-message response
does not expose the binding IDs. If the runtime does not expose a needed credential or run ID, stop and report
that precise limitation. A successful POST or a `pending` status does not prove delivery: accept only a status
whose `publication.state` is `published` and whose `publishedAt` is non-null (or the equivalent provider delivery
receipt). Never send a real owner message as a test.

## Errors and safe recovery

- `400` validation error: check `interactionIds` (non-empty IDs) and non-empty `text`; do not retry an empty body.
- `403 not_author_of_open_owner_decision`: only the author can explain their still-open owner decision. Stop; do
  not try another agent's identity.
- `404`: confirm the exact POST path above and check the deployed version/mount with the operator. Do not
  invent routes or keep searching the catalog for an absent tool.
- `409 summary_required`: include all of your open, unexplained owner decisions for that owner in one summary.
- `409 already_explained`: do not send again; wait for the owner.
- `409 no_owner_dm`: ask the operator to establish a supported direct chat; do not create another transport.

Write for the owner in their language: what to decide, why now, each option's consequence, your recommendation,
and how to answer. Avoid interaction IDs, API names, and tables.

## Step 2: process the owner's answer

The owner's text answer arrives as a normal message in your direct chat. When it does, your prompt carries the
note "The owner's message may answer an open decision" with the open interactions and the id of the owner's
comment.

If the owner explicitly decides: use `myrmidonResolveInteractionByOwnerReply` only if that tool is actually
available in the current tool catalog; otherwise use `POST /api/myrmidon/owner-message/resolve` with the same
run-scoped authentication described above. Supply `interactionId`, `ownerReplyCommentId`, `action` and `body`.

- `accept` / `reject` for `request_confirmation`; `respond` for `ask_user_questions`.
- `body`: accept `{}`; reject `{"reason": "..."}`;
  respond `{"answers": [{"questionId": "...", "optionIds": ["..."], "otherText": null}]}`.
- The interaction is closed as the OWNER (the activity log also names you as the one who carried the
  answer). You never resolve a human-only interaction as yourself.

The server refuses the resolve call unless `ownerReplyCommentId` is a message the owner wrote in that very
chat after your explanation (`403 no_owner_reply`), you are the author of the interaction, and the action
fits its kind (`422 action_kind_mismatch`). Silence, your own reasoning, or someone else's words never close a
decision. Tool-action confirmations, secret proposals and connection authorizations are not handled this way;
they stay explicit decisions on the board.
