---
settings-section: Track 5 — operations
---

## changelog-en

### DONE-GATE: protect pull-request work products from premature completion (1.6.6)

- Server-side completion now verifies every pull-request work product before allowing an issue to become `done`.
- Open or unknown provider state fails closed; a closed, unmerged pull request requires an explicit valid replacement reference.
- Verified merges are accepted, and task-PR synchronization persists verified merge state before completing an issue in its transaction.

## changelog-ru

### DONE-GATE: защита pull-request work product от преждевременного завершения (1.6.6)

- Серверная проверка завершения подтверждает каждый pull-request work product до перевода задачи в `done`.
- Открытое или неизвестное состояние провайдера блокирует завершение; закрытый невлитый PR требует явно указанной валидной ссылки на замену.
- Подтверждённый merge разрешает завершение, а синхронизация task-PR сохраняет подтверждённое состояние merge в транзакции до завершения задачи.

## settings-en

| `MYRMIDON_BOT_STATE_DIR` | 1.6.6-DONE-GATE | unset — the standard bot state directory is used | Overrides the directory where the managed bot installation keeps its host-machine identity and other persistent bot state. The directory is created and used by the installer; it is not a runtime feature flag | Unset — use the standard installation state directory. The path must be writable by the installer |

## settings-ru

| `MYRMIDON_BOT_STATE_DIR` | 1.6.6-DONE-GATE | не задан — используется стандартный каталог состояния бота | Переопределяет каталог, где управляемая установка бота хранит идентификатор хост-машины и другое постоянное состояние; каталог создаётся установщиком и не является runtime-флагом | Не задавать — использовать стандартный каталог установки; путь должен быть доступен установщику для записи |
