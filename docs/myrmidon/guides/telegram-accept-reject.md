# Telegram Commands for Plan Acceptance/Rejection

This guide describes the new Telegram commands that allow owners to accept or reject plans directly from Telegram chat.

## Commands

### `/accept <id>`
Accepts a plan card with the specified ID, creating the associated epic and tasks.

- Usage: `/accept <interaction-id>`
- Response: Confirmation with link to the created epic and number of tasks

Example:
```
/accept abc123def456
```

### `/reject <id>`
Rejects a plan card with the specified ID, cancelling it without creating tasks.

- Usage: `/reject <interaction-id>`
- Response: Confirmation that the card has been rejected

Example:
```
/reject abc123def456
```

## How It Works

1. When a plan is proposed via CTO chat, a `suggest_tasks` card is created on the standing conversation issue
2. The card ID can be used with `/accept` or `/reject` commands
3. `/accept` approves all tasks in the card through the same `acceptInteraction` service call the portal accept route uses — the board's code creates the epic and the child tasks
4. `/reject` closes the card as `rejected` through the same `rejectInteraction` service call the portal reject route uses — no tasks are created
5. Both commands verify that the user has permission to act on the card

## Security

- Only the company owner (active owner membership, as for `/plan`) can accept/reject cards, and only from their own bridged chat (the command context check from X8c: a command acts only on the caller's own bridged chat)
- Cards are validated to ensure they belong to the correct company and issue
- Only pending `suggest_tasks` cards can be accepted/rejected

## Integration Points

- Leverages the existing `suggest_tasks` interaction type
- Uses `issueThreadInteractionService.acceptInteraction` / `rejectInteraction` — the same board service as the portal's accept/reject endpoints, with no second implementation
- Integrates with the Telegram DM bridge infrastructure (X8c command runner)