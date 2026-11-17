# Owner update notifications (TG-NOTIFY)

> Русская версия: [Owner-update-notifications.ru](Owner-update-notifications.ru)


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
| `chatId` | `string \| null` | `null` | Explicit Telegram chat ID for update notifications. |
| `topicId` | `string \| null` | `null` | Forum topic thread ID inside a Telegram supergroup. |

### Reading settings without restart

`telegramNotify.updates` settings are persisted in instance storage (`instance_settings.general.myrmidonTelegramNotifySettings`) and read at the moment an update event occurs. No board or bot process restart is required — changes take effect immediately.

## Delivery routing

1. If `updates.enabled === false`, no message is queued.
2. Otherwise, the board resolves only the explicitly configured `updates.chatId` and optional `updates.topicId`. It does not fall back to an active owner's direct conversation.
3. If the configured destination resolves, the notification is queued in `chat_publications`. If the chat ID is missing or the destination cannot be resolved, nothing is queued and the notifier returns `no_destination_channel`. A missing chat ID is also logged.

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
