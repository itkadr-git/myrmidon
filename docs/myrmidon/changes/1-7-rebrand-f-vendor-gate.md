---
divergence-section: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички
settings-section: Track 5 — operations
---

## changelog-en

### Gate the vendor name in the built interface and the server answers (REBRAND-F)

- The rebrand keeps the vendor name only in the LICENSE, the third-party notices and the "based on ... (MIT)" line of About. The new gate `scripts/myrmidon/vendor-name/check-vendor-name.mjs` scans the built UI bundle (`ui/dist`) and the recorded response bodies of the main endpoints and counts the visible vendor name; identifier spellings (`@paperclipai/*`, `PAPERCLIP_*`, API paths, storage keys, headers) are reported but not gated for one release. Modes: `ratchet` (the visible count may not grow above the baseline) and `strict` (no occurrence outside the exceptions); CI fails a build that adds a new visible mention. Mode and baseline are editable on Instance -> General without a restart; `MYRMIDON_VENDOR_NAME_CHECK_MODE` / `MYRMIDON_VENDOR_NAME_CHECK_BASELINE` remain forced overrides (both are documented in docs/myrmidon/SETTINGS.md rows below).

## settings-en

| `MYRMIDON_VENDOR_NAME_CHECK_MODE` | unset — the policy file decides | Forced override of the vendor-name gate mode (`ratchet` or `strict`) |
| `MYRMIDON_VENDOR_NAME_CHECK_BASELINE` | unset — the policy file decides | Forced override of the visible vendor-name baseline |

## settings-ru

| `MYRMIDON_VENDOR_NAME_CHECK_MODE` | unset — policy file decides | принудительный режим сторожа (`ratchet` или `strict`) |
| `MYRMIDON_VENDOR_NAME_CHECK_BASELINE` | unset — policy file decides | принудительная базовая видимая частота |

## changelog-ru


### Сторож имени вендора в собранном интерфейсе и ответах сервера (REBRAND-F)

- Ребренд оставляет название вендора только в LICENSE, в файле сторонних уведомлений и в строке «based on ... (MIT)» на About. Новый сторож `scripts/myrmidon/vendor-name/check-vendor-name.mjs` читает собранный бандл интерфейса (`ui/dist`) и записанные тела ответов основных эндпоинтов и считает видимое имя вендора; написания-идентификаторы (`@paperclipai/*`, `PAPERCLIP_*`, пути API, ключи хранилища, заголовки) попадают в отчёт, но не гейтятся один релиз. Режимы: `ratchet` (число видимых вхождений не растёт выше базы) и `strict` (ни одного вхождения вне исключений); CI роняет сборку с новым видимым упоминанием. Режим и база меняются на Instance -> General без перезапуска; `MYRMIDON_VENDOR_NAME_CHECK_MODE` / `_BASELINE` — принудительные переопределения.

## divergence

| 1.7-REBRAND-F | Сторож имени вендора в собранном интерфейсе и в ответах сервера: `scripts/myrmidon/vendor-name/check-vendor-name.mjs` читает собранный бандл интерфейса (`ui/dist`) и записанные тела трёх основных эндпоинтов (`GET /`, `GET /site.webmanifest`, `GET /api/openapi.json` — снимки снимает `capture-snapshots.ts` теми же функциями сервера, что отдают сами эндпоинты: детерминированно, с отказом записи при секрете или внутреннем адресе). Считаются два класса: видимое имя (`\bPaperclip\b`) — гейт, написания-идентификаторы (`paperclip`: `@paperclipai/*`, `PAPERCLIP_*`, пути API, ключи хранилища, заголовки) — только отчёт, они живут один релиз как алиасы. Режимы `ratchet` (число видимых вхождений не растёт выше базы) и `strict` (ни одного вхождения вне исключений); исключения по файлам (LICENSE, NOTICE, сторонние уведомления, source maps) и по участкам текста (атрибуция MIT — `Based on Paperclip` и `Base: Paperclip {{version}} (MIT)` во всех локалях, внешние сервисы `Paperclip Cloud/Labs/EE/Enterprise`, заголовки `X-Paperclip-*`, старые фразы уведомлений восстановления) повторяют аллоулист сторожа B1a. Настройка экземпляра `general.vendorNameCheck` + панель «Имя вендора в сборке» на Instance → General показывают режим, базу и источник каждого значения и число вхождений собственной сборки (`GET`/`PATCH /api/myrmidon/vendor-name-check`), переменные `MYRMIDON_VENDOR_NAME_CHECK_MODE`/`_BASELINE` — принудительное переопределение | Файлы вендора: `.github/workflows/myrmidon-ci.yml` (два шага: полоса сборки — свежие снимки + бандл, полоса `checks` — закоммиченные снимки), `scripts/myrmidon/ci/select.mjs` и `select.test.mjs` (полный уровень CI при изменении `scripts/myrmidon/vendor-name/**`), `packages/shared/src/validators/instance.ts`, `packages/shared/src/types/instance.ts`, `server/src/services/instance-settings.ts`, `server/src/app.ts`, `ui/src/pages/InstanceGeneralSettings.tsx` — везде строка с маркером `myrmidon(REBRAND-F)`. Наши файлы: `scripts/myrmidon/vendor-name/**`, `packages/shared/src/myrmidon-vendor-name{,.test}.ts`, `server/src/myrmidon/vendor-name/**`, `ui/src/components/myrmidon/VendorNameCheck*`, `docs/myrmidon/guides/rebrand-vendor-name{,.ru}.md`, строки в `docs/myrmidon/{SETTINGS,SETTINGS.ru}.md` и `docs/myrmidon/README.md` | Требование 1.7: название вендора остаётся только в LICENSE, файле сторонних уведомлений и строке «based on … (MIT)» в About, всё остальное — Myrmidon. Новый вендорский текст в бандле интерфейса или в теле ответа должен ронять CI, а не находиться вычиткой; режим-храповик не даёт числу расти до слияния REBRAND A/B | `scripts/myrmidon/vendor-name/check-vendor-name.test.mjs` (критерий приёмки: добавленная строка с именем вендора в собранном интерфейсе роняет проверку; исключения по файлам и по тексту; классы видимое/идентификатор; режимы ratchet/strict и приоритет источника; «падать закрыто» на нечитаемой политике и отсутствующей цели; машинный отчёт), `scripts/myrmidon/ci/select.test.mjs`, `packages/shared/src/myrmidon-vendor-name.test.ts`, `server/src/myrmidon/vendor-name/vendor-name-check.myrmidon.test.ts`, `ui/src/components/myrmidon/VendorNameCheckSettingsPanel.myrmidon.test.tsx` | Никогда, наше поведение. Снятие: убрать оба шага из `myrmidon-ci.yml` и полный триггер из `select.mjs` — вернётся прежнее состояние, когда сборку никто не проверяет | (этот PR) |
