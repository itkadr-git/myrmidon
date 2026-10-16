# @paperclipai/plugin-mail-imap

Bundled Paperclip plugin: reads new mail from an IMAP mailbox and sorts it into
folders by configurable rules. First slice of the mail-plugin epic (OPE-3383):
connect, read, sort. OCR of PDF attachments and ticket creation are out of
scope for this slice.

## Features

- Connects to an IMAP mailbox with credentials from a company secret ref
  (the secret value is never stored in plugin config or the plugin database).
- Scheduled job `mail-sync` (default cron `*/5 * * * *`) reads new messages
  using a persistent UID cursor, so each message is processed exactly once
  across restarts.
- Rule-based sorting: ordered rules matched on `fromContains`,
  `subjectContains`, `hasAttachment` move messages into target IMAP folders;
  an optional default folder catches everything else.
- Processing log in the plugin database namespace (`mail_log` + `sync_runs`
  tables, migration `001_mail_log.sql`) plus activity-log entries and metrics.
- Actions: `sync-now` (manual run) and `test-connection` (verifies login from
  the settings UI).

## Installation

The plugin is bundled and auto-discovered from `packages/plugins/` by the
server. Build it once (`pnpm --filter @paperclipai/plugin-mail-imap build`),
then enable it from company settings (Plugins section).

## Configuration (per company, in plugin settings)

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `imapHost` | yes | — | IMAP server host |
| `imapPort` | no | `993` | IMAP port |
| `imapTls` | no | `true` | Use TLS (implicit TLS on connect) |
| `username` | yes | — | Mailbox login |
| `passwordSecretRef` | yes | — | Company secret ref holding the mailbox password |
| `sourceFolder` | no | `INBOX` | Folder to read new mail from |
| `defaultTargetFolder` | no | — | Folder for messages matching no rule (empty = keep in source) |
| `maxMessagesPerRun` | no | `50` | Max messages processed per run (hard cap 500) |
| `sortRules` | no | `[]` | Ordered list of rules (see below) |

Example:

```json
{
  "imapHost": "imap.example.com",
  "imapPort": 993,
  "imapTls": true,
  "username": "robot@example.com",
  "passwordSecretRef": { "type": "secret_ref", "secretId": "<company-secret-uuid>" },
  "sourceFolder": "INBOX",
  "defaultTargetFolder": "Misc",
  "maxMessagesPerRun": 50,
  "sortRules": [
    { "name": "newsletters", "fromContains": "news@", "targetFolder": "Read later" },
    { "name": "invoices", "subjectContains": "invoice", "hasAttachment": true, "targetFolder": "Finance" }
  ]
}
```

### Sort rules

Rules are evaluated top-down; the first rule whose conditions all match wins
(conditions are ANDed). A rule with no conditions matches everything. A
message that matches nothing is moved to `defaultTargetFolder`, or left in the
source folder when no default is set. Matching is case-insensitive substring
on the From header and Subject. Only envelope metadata (From/Subject/flags)
is fetched — message bodies and attachments are never downloaded.

## Actions

- `sync-now` — runs one sync pass immediately for the current company.
- `test-connection` — connects with the configured credentials, selects the
  source folder and reports the highest UID; returns `{ ok: false, status: 400, error }`
  on failure.

## Development

```bash
pnpm --filter @paperclipai/plugin-mail-imap exec tsc --noEmit   # type check
pnpm --filter @paperclipai/plugin-mail-imap test                # unit + in-process IMAP-double tests
pnpm --filter @paperclipai/plugin-mail-imap build               # bundle dist/worker.js (esbuild)
```

Tests run fully in-process against an in-memory IMAP double — no external
network or mailbox is needed.
