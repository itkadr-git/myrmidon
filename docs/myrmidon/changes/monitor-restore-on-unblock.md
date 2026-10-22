---
settings-section: Track 5 — operations
---

ID: MON-RESTORE
Причина: recovery-блокировка (clearReason=invalid_status) молча гасила монитор; теперь его состояние восстанавливается при возвращении активному агенту, а факт гашения публикуется системным комментарием.
Как снимать: когда вендор сам восстанавливает монитор после recovery-блока, удалить все участки `myrmidon(MON-RESTORE)` и тест `server/src/__tests__/issue-execution-policy.myrmidon.test.ts`.

## changelog-en

### Restore monitor after recovery unblock (MON-RESTORE)
- Restore monitors cleared by recovery blocking and publish clear notices.

## changelog-ru

### Восстанавливать монитор после recovery-блокировки (MON-RESTORE)
- Восстанавливать мониторы после recovery-блокировки и публиковать уведомления об их гашении.

## settings-en

| Настройки | `MON-RESTORE` | Нет | Новых настроек не добавлено | Не применимо |

## settings-ru

| Настройки | `MON-RESTORE` | Нет | Новых настроек не добавлено | Не применимо |
