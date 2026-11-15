# Owner update notifications (TG-NOTIFY)

## Overview

As part of **1.7 AUTO-UPDATE-SETTINGS** (OPE-8656), Telegram notifications keep the product owner informed of key lifecycle events during automatic updates.

Notifications support the following events:
- **Canary started** (`canary_started`): start of a canary rollout for a new version (including version/hash and canary parameters).
- **Rollout succeeded** (`rollout_succeeded`): update rollout completed across all instances.
- **Rollback started** (`rollback_started`): canary or rollout issues detected and automatic rollback initiated.
- **Rollback completed** (`rollback_completed`): rollback to the stable version completed with the exact failure reason.
- **Waiting window** (`waiting_window`): notification that the update is waiting for an allowed maintenance window.

## Settings (`telegramNotify.updates`)

Update notification settings belong to the company-level `telegramNotify` configuration document:

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch for update notifications. Disabled by default. |
| `chatId` | `string \| null` | `null` | Telegram chat ID for direct delivery (used when no active owner-delivery channel exists). |
| `topicId` | `string \| null` | `null` | Forum topic thread ID inside a Telegram supergroup. |

### Reading settings without restart

`telegramNotify.updates` settings are persisted in instance storage (`instance_settings.general.myrmidonTelegramNotifySettings`) and read at the moment an update event occurs. No board or bot process restart is required — changes take effect immediately.

## Delivery routing

Messages are routed according to the following sequence:
1. **Active check**: if `updates.enabled === false`, no message is sent and the queue is untouched.
2. **Owner-delivery (primary channel)**: checks for an active direct owner channel (Telegram DM via user binding or active session). If found, the notification is sent there.
3. **Direct Telegram send (fallback channel)**: if no active owner-delivery exists, the message is posted to the chat/topic configured in `updates.chatId` and `updates.topicId` via the outbound message queue (`chat_publications`).
4. If neither channel is configured, nothing is sent and `no_destination_channel` is logged.

## API management

### Fetch current settings
```http
GET /api/myrmidon/telegram-notify
```
The response includes the `updates` section:
```json
{
  "settings": {
    "updates": {
      "enabled": false,
      "chatId": null,
      "topicId": null
    }
  }
}
```

### Enable notifications
```http
PATCH /api/myrmidon/telegram-notify
Content-Type: application/json

{
  "updates": {
    "enabled": true,
    "chatId": "-1001234567890",
    "topicId": "42"
  }
}
```
Each parameter change is recorded in the `telegramNotify` document's `changelog`.
