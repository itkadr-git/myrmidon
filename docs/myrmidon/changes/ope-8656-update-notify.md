---
settings-section: Track 5 — operations
---

## changelog-en

### Telegram notifications for auto-update lifecycle events (OPE-8656)

- Owner notifications via Telegram on update lifecycle events: canary start, rollout success, auto-rollback with reason, and waiting for maintenance window.
- Delivery routed through active owner-delivery channel if present, otherwise direct Telegram chat/topic fallback.
- Added `telegramNotify.updates` configuration (`enabled`, `chatId`, `topicId`), disabled by default.

## changelog-ru

### Уведомления владельцу в Telegram о событиях жизненного цикла автообновления (OPE-8656)

- Уведомления владельца в Telegram о событиях автообновления: запуск канарейки, успешный выкат, автооткат с указанием причины и ожидание окна обслуживания.
- Доставка осуществляется через активный канал доставки владельцу (owner-delivery), при его отсутствии — прямая отправка в указанные чат/топик Telegram.
- Добавлен раздел настроек `telegramNotify.updates` (`enabled`, `chatId`, `topicId`), по умолчанию отключён.

## settings-en

| `telegramNotify.updates.enabled` | 1.7-AUTO-UPDATE-SETTINGS | `false` | Master switch. When `true`, update lifecycle events (canary started, rollout succeeded, rollback started/completed, waiting maintenance window) dispatch notifications to the owner | `false` or missing — silence: no update notifications staged or sent |
| `telegramNotify.updates.chatId` | 1.7-AUTO-UPDATE-SETTINGS | `null` | Target Telegram chat id for update notifications when direct fallback is used | `null` or missing — fallback delivery is skipped if owner-delivery is unavailable |
| `telegramNotify.updates.topicId` | 1.7-AUTO-UPDATE-SETTINGS | `null` | Topic thread id inside a forum chat for update notifications | `null` — chat-level conversation |

## settings-ru

| `telegramNotify.updates.enabled` | 1.7-AUTO-UPDATE-SETTINGS | `false` | Главный переключатель. При `true` события жизненного цикла обновления (старт канарейки, успешный rollout, начало/завершение автоотката, ожидание окна) отправляют уведомления владельцу | `false` или отсутствует — тишина: уведомления об обновлениях не формируются |
| `telegramNotify.updates.chatId` | 1.7-AUTO-UPDATE-SETTINGS | `null` | Идентификатор целевого чата Telegram для уведомлений об обновлениях при использовании прямого fallback | `null` или отсутствует — прямая отправка пропускается, если owner-delivery недоступен |
| `telegramNotify.updates.topicId` | 1.7-AUTO-UPDATE-SETTINGS | `null` | Идентификатор темы форума в чате Telegram для уведомлений об обновлениях | `null` — сообщение отправляется на уровень чата |
