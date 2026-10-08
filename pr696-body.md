## Что это

Экран «Фуражировка» получает вторую половину правила «обучение только в простое»: переключатель с показом ИСТОЧНИКА действующего значения (интерфейс / переменная окружения / по умолчанию) и история проходов — когда прошёл, сколько источников прочитано, сколько находок, какие роли оставлены без внимания и с какой причиной (`queue_not_empty` / `no_idle_agent`).

Ветка несёт правило целиком, поверх текущего `main` (не стек на другой PR):

- **гейт**: очередь роли (готовая очередь роя — `todo` без исполнителя) пуста И есть свободный агент роли; занятая роль пропускается в этом проходе, проход продолжается с источниками других ролей. Тоггл `instance_settings.general.foragingIdleGate` перечитывается на каждом проходе — переключение действует со следующего прохода без перезапуска; env `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` — только принудительное переопределение. `GET/PATCH /api/myrmidon/foraging/idle-gate` (чтение — участник доски, запись — администратор инстанса).
- **журнал проходов**: `instance_settings.general.foragingPassJournal`, читается `GET /api/myrmidon/companies/:id/foraging/passes?limit=` (доступ к компании). Потолок — 50 записей НА КОМПАНИЮ; запись строки сериализована; каждый проход дописывает себя на любом выходе, неудачная запись журнала не роняет проход.
- **интерфейс**: `ui/src/pages/Foraging.tsx`, `ui/src/api/foraging.ts`; строки RU/EN; тест компонента.
- **документация**: руководство EN + RU (`docs/myrmidon/guides/foraging-idle-gate.{en,ru}.md`) и фрагмент изменений (`docs/myrmidon/changes/1-6-3-foraging-idle-gate-ui.md`) с разделом про настройку `MYRMIDON_FORAGING_IDLE_GATE_ENABLED`.

## Правки по ревью 08.10

1. **Переключатель больше не откатывается после второго щелчка.** В вендорском пути записи `general` preserve-строка ключа стояла после `...nextGeneral` и перекрывала патч, поэтому держался только первый щелчок (вкл → выкл → вкл оставался на значении первого). Добавлена строка «патч побеждает» — как у ключей DM-PROGRESS и fallback-signal; дубль preserve-строки в `normalizeGeneralSettings` убран. Регрессионный тест проходит последовательность сохранений: `server/src/services/instance-settings-foraging-idle-gate.myrmidon.test.ts`.
2. **Журнал ограничен на компанию, а не на инстанс** (`packages/shared/src/myrmidon-foraging-pass-journal.ts`): занятая компания больше не вытесняет историю других. Read-modify-write строки сериализован (`server/src/myrmidon/foraging/pass-journal.ts`) — два прохода, записывающиеся одновременно, сохраняются оба.
3. **Семантика гейта приведена к ревьюированной серверной половине** (`server/src/myrmidon/foraging/service.ts`): `db` снова необязателен, без подключённого тоггла (или без проверки простоя) гейт не применяется, ошибка чтения тоггла гасит гейт и пишет предупреждение в лог — вместо молчаливого включения.

## Проверка

- Сервер: `pnpm --filter @paperclipai/server vitest run src/myrmidon/foraging` — проход, гейт, журнал, маршруты журнала.
- Настройки: `pnpm --filter @paperclipai/server vitest run src/services/instance-settings-foraging-idle-gate.myrmidon.test.ts`.
- Общий контракт: `pnpm --filter @paperclipai/shared vitest run src/myrmidon-foraging-pass-journal.myrmidon.test.ts`, `src/myrmidon-foraging-idle-gate.test.ts`.
- Интерфейс: `pnpm --filter @paperclipai/ui vitest run src/pages/Foraging.test.tsx src/i18n`.
- CI на голове ветки — до зелёного.

Критерии приёмки покрыты тестами: переключение меняет следующий проход без перезапуска; пропуск отображается с причиной; в RU нет английских строк (guard-тест в CI).