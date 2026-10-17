---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### Licensing screen: installation id, license request and license issue form (LICENSING)

- New section Settings → Instance → General → Licensing (instance admins only).
  It shows the installation id (`myr-` + 20 hex of `sha256(machine-id)`, the same
  algorithm the closed connector modules use; `GET /api/licensing/install-id`),
  and a one-click "Copy license request" (a one-line `MYRQ1.…` blob).
- The owner pastes a client's request (or an id) into the issue form, picks
  modules, the term in days and a client/watermark, and the board signs a
  `MYR1.<payload>.<signature>` license with an Ed25519 key read from
  `MYRMIDON_LICENSE_ISSUER_KEY_FILE`. The key is never returned by the API or
  logged; without it the form says so and refuses. Issued licenses are journaled
  (metadata only). See `docs/myrmidon/guides/licensing.md`.

## changelog-ru

### Экран лицензирования: идентификатор установки, запрос лицензии и форма выпуска (LICENSING)

- Новый раздел Настройки → Инстанс → Общие → Лицензирование (только администратор
  инстанса). Показывает идентификатор установки (`myr-` + 20 hex от
  `sha256(machine-id)`, тем же алгоритмом, что и закрытые модули-коннекторы;
  `GET /api/licensing/install-id`) и кнопку «Скопировать запрос лицензии» (строка
  `MYRQ1.…`).
- Владелец вставляет запрос клиента (или идентификатор) в форму выпуска, выбирает
  модули, срок в днях и клиента/водяной знак, и доска подписывает лицензию
  `MYR1.<payload>.<signature>` ключом Ed25519 из `MYRMIDON_LICENSE_ISSUER_KEY_FILE`.
  Ключ API не возвращает и в логи не пишет; без него форма сообщает об этом и
  отказывает. Выпуски пишутся в журнал (только метаданные). См.
  `docs/myrmidon/guides/licensing.ru.md`.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| LICENSING | Новый модуль `server/src/myrmidon/licensing/**` (идентификатор установки, формат лицензии MYR1/MYRQ1, подпись Ed25519, журнал) и панель `LicensingSettingsPanel`. В вендорских файлах — по одной строке с маркером `myrmidon(LICENSING)`. | `server/src/app.ts` (импорт и `api.use(licensingRoutes())`), `ui/src/pages/InstanceGeneralSettings.tsx` (импорт и `<LicensingSettingsPanel />`) | Владелец выпускает лицензии закрытых модулей из интерфейса доски, клиент запрашивает лицензию одной кнопкой | `server/src/myrmidon/licensing/licensing.myrmidon.test.ts`, `ui/src/components/myrmidon/LicensingSettingsPanel.myrmidon.test.tsx` | Убрать две строки с маркером и каталог `server/src/myrmidon/licensing/`, панель | этот PR |

## settings-en-new

### 1.6.6 — LICENSING: installation id and license issue

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_LICENSE_ISSUER_KEY_FILE` | LICENSING | unset | Path to the Ed25519 private key (PEM) the board signs module licenses with. Read per issue, never returned or logged. | Unset — the issue form reports "not configured" and issuing is refused with 409. |
| `MYRMIDON_LICENSE_JOURNAL_FILE` | LICENSING | `<instance root>/data/licensing/issued.jsonl` | Append-only JSON-lines journal of issued licenses (metadata only, never the license text). | Keep it on a persistent volume. |
| `MYR_LICENSE_INSTANCE_ID` · `MYR_LICENSE_STATE_DIR` | LICENSING | unset · `~/.local/state/myrmidon-license` | Same variables the closed modules read: explicit installation id override and the cache directory of a generated id when no machine id exists. | Must be identical for the board and the modules. |

## settings-ru-new

### 1.6.6 — LICENSING: идентификатор установки и выпуск лицензий

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_LICENSE_ISSUER_KEY_FILE` | LICENSING | не задана | Путь к закрытому ключу Ed25519 (PEM), которым доска подписывает лицензии модулей. Читается при каждом выпуске, не возвращается и не логируется. | Не задана — форма выпуска пишет «не настроен», выпуск отклоняется кодом 409. |
| `MYRMIDON_LICENSE_JOURNAL_FILE` | LICENSING | `<корень инстанса>/data/licensing/issued.jsonl` | Журнал выпущенных лицензий (JSON lines, только метаданные, без текста лицензии). | Держите на постоянном томе. |
| `MYR_LICENSE_INSTANCE_ID` · `MYR_LICENSE_STATE_DIR` | LICENSING | не заданы · `~/.local/state/myrmidon-license` | Те же переменные, что читают закрытые модули: явное значение идентификатора и каталог кэша сгенерированного идентификатора, когда machine-id нет. | У доски и модулей должны совпадать. |
