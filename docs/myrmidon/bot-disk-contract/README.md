# Контракт диска ботов (BOT-DISK-H0)

Интерфейсный контракт эпика BOT-DISK-H (дизайн, разделы 1–4, 8). Все задачи
H1–H10 пишут код только против этих схем и фикстур; изменение поля здесь — это
изменение контракта и идёт через тред эпика, никогда молча.

- Типы и константы: `packages/shared/src/myrmidon-bot-workspace.ts`
  (реэкспортированы из `@paperclipai/shared`).
- Фикстуры: `docs/myrmidon/bot-disk-contract/*.json` — каждая проходит свою
  схему; тест `packages/shared/src/myrmidon-bot-workspace.test.ts` это
  гарантирует и используется всеми задачами как стабы.

## Разделы контракта

| Раздел | Что | Схемы |
|---|---|---|
| C1 | Раскладка каталогов (в контейнере) | константы `MYRMIDON_HOME_DIR`, `WS_GIT_BASE_DIR`, `WS_ARCHIVE_DIR`, `WS_REGISTRY_PATH`, `WS_DISK_STATE_PATH`, `WS_WORKSPACE_ROOT`, `WS_SCRATCH_ROOT`, `wsRegistrySchema`, `wsDiskStateSchema` |
| C2 | CLI `myr-ws` | `MYR_WS_EXIT`, `MYR_WS_QUOTA_ERROR_PREFIX`, `myrWsOpenResultSchema`, `myrWsListResultSchema`, `myrWsCloseResultSchema`, `myrWsRestoreResultSchema`, `myrWsMigrateResultSchema`, `myrWsErrorResultSchema` |
| C3 | Целевое состояние | `wsDesiredStateSchema` (`GET /api/myrmidon/bots/me/workspaces`) |
| C4 | Отчёт о диске | `wsDiskReportSchema`, `wsDiskReportResponseSchema` (`POST /api/myrmidon/bots/me/disk-report`, тело ≤ 1 МиБ) |
| C5 | dockergate | `wsDiskApiResponseSchema` (`GET /myrmidon/disk`, маршрут A14), `wsDiskQuotaPutRequestSchema`/`wsDiskQuotaPutResponseSchema` (`PUT /myrmidon/disk/<botKey>/quota`, маршрут A15), границы `WS_QUOTA_MIN/MAX_BYTES`, коды `WS_DOCKERGATE_DENY` |
| C6 | `/v1/runs` | `runWorkspaceFieldSchema` — поле `workspace`; `RUN_WORKSPACE_FALLBACK_DIR` |
| C7 | Настройки и карточки | `wsBotDiskSettingsSchema`, `WS_BOT_DISK_SETTING_DEFAULTS`, `WS_CARD_KEYS` |

## Как пользоваться

- Серверные маршруты C3/C4 импортируют схемы из `@paperclipai/shared` и
  сериализуют ровно их (лишние поля не добавляем — контракт зафиксирован).
- `myr-ws` (H1/H2) выводит ровно `myrWs*ResultSchema` при `--json`; коды выхода —
  только из `MYR_WS_EXIT`.
- dockergate (H4) отвечает ровно схемами C5; deny-коды — только из
  `WS_DOCKERGATE_DENY`.
- Клиентский код тестов берёт фикстуры из этого каталога как стабы ответов.

## Фикстуры

`ws-registry.json`, `disk-state.json`, `myr-ws-open.json`, `myr-ws-list.json`,
`myr-ws-close.json`, `myr-ws-restore.json`, `myr-ws-migrate.json`,
`myr-ws-error.json`, `desired-state.json`, `disk-report.json`,
`disk-report-response.json`, `dockergate-disk.json`,
`dockergate-quota-put-request.json`, `dockergate-quota-put-response.json`,
`run-workspace-field.json`, `botdisk-settings.json`.

## rc.9 additions to C3 (optional fields)

- `closedKeys[]`: issue keys of done/cancelled tasks the bot holds or held, with no lookback limit.
  botd removes a legacy directory named like a task only for a key listed here; a key in `protectKeys`
  or listed in `workspaces` but not closed is kept; without the field nothing under `/workspace` is removed.
- `grace.legacyPressureIdleDays` (1..90, default 7): idle days before a named directory without a closing
  task is archived under hard pressure.
- The route answers 503 when `general.botDisk.enabled` is false; botd treats it as no desired state.
