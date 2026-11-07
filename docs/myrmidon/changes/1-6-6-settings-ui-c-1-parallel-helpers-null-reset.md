## changelog-en

### Parallel helpers: clear host-capacity hints

- Clearing Shared build slots or Dev host memory now sends an explicit `null` in the settings PATCH, removing the stored capacity hint. Server validation and persistence already accept nullable values.

## changelog-ru

### Параллельные помощники: очистка параметров ёмкости хоста

- При очистке полей Shared build slots и Dev host memory UI теперь отправляет явный `null` в PATCH настроек, удаляя сохранённое значение. Серверные валидация и сохранение уже поддерживают nullable-поля.

## divergence-new

### 1.6.6 — SETTINGS-UI C-1: очистка host-capacity hints для parallel helpers

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| SETTINGS-UI-C-1 | Очистка `buildSlots` и `hostMemoryMb` отправляет `null`; серверная схема принимает `null`, сервис сохраняет сброс | `ui/src/components/myrmidon/ParallelHelpersSettingsPanel.tsx`, `server/src/myrmidon/parallel-helpers` | Позволить удалить ошибочно заданные параметры ёмкости без ручного PATCH | UI тестирует тело PATCH; серверный тест проверяет принятие `null`, сохранение и аудит | Никогда, наше поведение; снять с UI/API и тестами при отказе от полей ёмкости | (этот PR) |
