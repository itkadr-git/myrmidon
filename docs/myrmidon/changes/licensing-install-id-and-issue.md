---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### Installation id for closed-module licensing (LICENSING)

- `GET /api/licensing/install-id` (instance admins only) returns the
  installation id (`myr-` + 20 hex of `sha256(machine-id)`, the same algorithm
  the closed connector modules use). The board does not issue licenses: issuing
  is the vendor's closed module. See `docs/myrmidon/guides/licensing.md`.

## changelog-ru

### Идентификатор установки для лицензирования закрытых модулей (LICENSING)

- `GET /api/licensing/install-id` (только администратор инстанса) возвращает
  идентификатор установки (`myr-` + 20 hex от `sha256(machine-id)`, тем же
  алгоритмом, что и закрытые модули-коннекторы). Доска лицензии не выпускает:
  выпуск — закрытый модуль поставщика. См. `docs/myrmidon/guides/licensing.ru.md`.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| LICENSING | Новый модуль `server/src/myrmidon/licensing/**` (идентификатор установки, формат лицензии MYR1/MYRQ1, только проверка открытым ключом). В вендорском файле — строка с маркером `myrmidon(LICENSING)`. | `server/src/app.ts` (импорт и `api.use(licensingRoutes(...))`) | Клиент запрашивает лицензию закрытых модулей одной кнопкой | `server/src/myrmidon/licensing/licensing.myrmidon.test.ts` | Убрать строки с маркером и каталог `server/src/myrmidon/licensing/` | этот PR |

## settings-en-new

### 1.6.6 — LICENSING: installation id

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYR_LICENSE_INSTANCE_ID` · `MYR_LICENSE_STATE_DIR` | LICENSING | unset · `~/.local/state/myrmidon-license` | Same variables the closed modules read: explicit installation id override and the cache directory of a generated id when no machine id exists. | Must be identical for the board and the modules. |

## settings-ru-new

### 1.6.6 — LICENSING: идентификатор установки

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYR_LICENSE_INSTANCE_ID` · `MYR_LICENSE_STATE_DIR` | LICENSING | не заданы · `~/.local/state/myrmidon-license` | Те же переменные, что читают закрытые модули: явное значение идентификатора и каталог кэша сгенерированного идентификатора, когда machine-id нет. | У доски и модулей должны совпадать. |
