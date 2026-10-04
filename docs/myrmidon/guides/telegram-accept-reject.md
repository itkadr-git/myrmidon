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
3. `/accept` approves all tasks in the card and creates them as sub-issues
4. `/reject` cancels the card without creating any tasks
5. Both commands verify that the user has permission to act on the card

## Security

- Only the owner of the Telegram conversation can accept/reject cards
- Cards are validated to ensure they belong to the correct company and issue
- Only pending `suggest_tasks` cards can be accepted/rejected

## Integration Points

- Leverages the existing `suggest_tasks` interaction type
- Uses the same acceptance path as the portal interface
- Integrates with the Telegram DM bridge infrastructure