## changelog-en

### Experimental workspace-repair and duplex switches in Instance Settings (1.6.6 SETTINGS-UI)

- Added settings cards in Settings > Instance > Experimental for existing runtime keys:
  - `enableWorkspaceBranchReconcileForward`: allows runtime to fast-forward execution workspace branch on branch-containment check before run starts. Kill-switch semantics: turning off prevents automatic fast-forward if manual diagnostic is required.
  - `enableWorkspaceDirtyQuarantineRepair`: automatically quarantines dirty workspaces and repairs clean worktree before run. Kill-switch semantics: turning off preserves untouched dirty worktree state for post-mortem forensics.
  - `enableSandboxDuplexBridge`: duplex stream transport for sandbox runner communications. Kill-switch semantics: turning off falls back to file bridge transport when socket/pipe duplex experiences transport degradation.
- Clear kill-switch and availability descriptions in RU and EN; values are managed via existing instance settings GET/PATCH endpoints and properly respect cloud-managed read-only locks.
- `enablePipelines` remains without runtime-consumer and is not enabled in production configurations.

## changelog-ru

### Экспериментальные переключатели восстановления workspace и duplex-моста в настройках экземпляра (1.6.6 SETTINGS-UI)

- Добавлены карточки настроек в Настройки > Экземпляр > Экспериментальные для существующих ключей рантайма:
  - `enableWorkspaceBranchReconcileForward`: позволяет рантайму перемотать ветку рабочей копии вперёд при расхождении с базой до запуска. Семантика kill-switch: отключение предотвращает автоперемотку при необходимости ручной диагностики.
  - `enableWorkspaceDirtyQuarantineRepair`: автоматический карантин грязных рабочих копий и восстановление чистого дерева перед запуском. Семантика kill-switch: отключение сохраняет состояние грязного дерева для расследования инцидентов.
  - `enableSandboxDuplexBridge`: дуплексный потоковый транспорт для коммуникации с sandbox runner. Семантика kill-switch: отключение переключает рантайм на файловый мост при сбоях сокетов или пайпов.
  - Чёткие описания kill-switch семантики и условий доступности на русском и английском языках; управление через существующие GET/PATCH маршруты настроек экземпляра с поддержкой cloud-managed блокировок.
- Ключ `enablePipelines` оставлен без изменений и не включается в production до реализации потребителя.

## divergence-append
<!-- section: Трек 1 — платформа -->
| SETTINGS-UI-EXPERIMENTAL-REPAIR | Карточки настроек workspace-repair и sandbox duplex bridge в InstanceExperimentalSettings | `ui/src/pages/InstanceExperimentalSettings.tsx`, `ui/src/i18n/myrmidon-locales/areas/settings-company.{en,ru}.json` | Предоставление UI для существующих kill-switch ключей рантайма (аудит A2 строки 239-240, 242) с RBAC и managed-lock | `ui/src/pages/InstanceExperimentalSettings.test.tsx` | Когда вендор предоставит стандартный UI для данных экспериментальных настроек | (этот PR) |
