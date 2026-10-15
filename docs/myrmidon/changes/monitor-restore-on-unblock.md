ID: MON-RESTORE
Причина: recovery-блокировка (clearReason=invalid_status) молча гасила монитор; теперь его состояние восстанавливается при возвращении активному агенту, а факт гашения публикуется системным комментарием.
Как снимать: когда вендор сам восстанавливает монитор после recovery-блока, удалить все участки `myrmidon(MON-RESTORE)` и тест `server/src/__tests__/issue-execution-policy.myrmidon.test.ts`.
Настройки: нет. Миграции: нет.

Changelog (en): Restore monitors cleared by recovery blocking and publish clear notices.
Changelog (ru): Восстанавливать мониторы после recovery-блокировки и публиковать уведомления об их гашении.
