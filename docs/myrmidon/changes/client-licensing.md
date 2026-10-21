---
divergence-section: Трек 6 — безопасность и модели
settings-section: Track 6 — security and models
---

## changelog-en

### Licenses screen: request, install and state of closed-module licenses (LICENSING)

- New screen Settings → Instance → Licenses (instance admins only). It shows the
  installation id, a one-click "Copy request" (`MYRQ1.…`, byte-identical to the
  modules' own `build_request`, naming the closed modules installed into this
  board), the state of every closed module's license (valid until a date /
  expiring / expired / not for this installation / not included / no license /
  invalid signature) and an install form: paste the `MYR1.…` line or load
  `license.key`.
- The board verifies the license with the embedded vendor public key exactly as
  the modules do, refuses one that no module would accept, and writes it in
  place to the file the modules read (`MYR_LICENSE_PATH`, default
  `/etc/myrmidon-license/license.key`). Several trusted public keys and a `kid`
  field are supported for key rotation; licenses without `kid` keep verifying.
- A banner in the common layout tells instance admins when an installed closed
  module has no working license and links to the screen.
- The installer mounts the host license directory into the board read-write and
  sets `MYR_LICENSE_PATH`, so the adapter inside the board and the modules on the
  host read the same file. See `docs/myrmidon/guides/licensing.md`.
- The board no longer issues licenses: the issue form, `POST /api/licensing/issue`,
  `POST /api/licensing/parse-request`, `GET /api/licensing/issued` and the
  variables `MYRMIDON_LICENSE_ISSUER_KEY_FILE` / `MYRMIDON_LICENSE_JOURNAL_FILE`
  are removed; the core never loads a private key. Issuing is the vendor's
  closed module.

### Plugins see whether the user is an instance admin (PLUGIN-INSTANCE-ADMIN)

- The host-verified actor of a plugin action (`context.actor`) now carries
  `isInstanceAdmin` (true only for a board user with the instance admin role),
  and the UI host context of plugin pages and slots carries `isInstanceAdmin`
  for rendering. A plugin can restrict an action to the instance admin without
  keeping its own user list. The SDK test harness accepts
  `actor.isInstanceAdmin`. Data calls carry no actor, as before.

## changelog-ru

### Экран «Лицензии»: запрос, установка и состояние лицензий закрытых модулей (LICENSING)

- Новый экран Настройки → Инстанс → Лицензии (только администратор инстанса).
  Показывает идентификатор установки, кнопку «Скопировать запрос» (`MYRQ1.…`,
  байт в байт как `build_request` самих модулей, с закрытыми модулями этой
  доски), состояние лицензии каждого закрытого модуля (действует до даты /
  истекает / истекла / не для этой установки / не входит в лицензию / нет
  лицензии / подпись неверна) и форму установки: вставить строку `MYR1.…` или
  загрузить `license.key`.
- Доска проверяет лицензию встроенным открытым ключом поставщика тем же
  алгоритмом, что модули, отклоняет лицензию, которую не примет ни один модуль,
  и записывает её на месте в файл, который читают модули (`MYR_LICENSE_PATH`,
  по умолчанию `/etc/myrmidon-license/license.key`). Для смены ключа
  поддерживаются несколько доверенных открытых ключей и поле `kid`; лицензии без
  `kid` продолжают проверяться.
- Баннер в общем макете сообщает администратору, что у установленного закрытого
  модуля нет действующей лицензии, и ведёт на экран.
- Установщик монтирует каталог лицензии хоста в доску на запись и задаёт
  `MYR_LICENSE_PATH`: адаптер внутри доски и модули на хосте читают один файл.
  См. `docs/myrmidon/guides/licensing.ru.md`.
- Доска больше не выпускает лицензии: форма выпуска, `POST /api/licensing/issue`,
  `POST /api/licensing/parse-request`, `GET /api/licensing/issued` и переменные
  `MYRMIDON_LICENSE_ISSUER_KEY_FILE` / `MYRMIDON_LICENSE_JOURNAL_FILE` удалены;
  ядро не загружает закрытый ключ. Выпуск — закрытый модуль поставщика.

### Плагины знают, администратор ли пользователь (PLUGIN-INSTANCE-ADMIN)

- Проверенный доской актёр действия плагина (`context.actor`) теперь несёт
  `isInstanceAdmin` (true только у пользователя доски с ролью администратора
  инстанса), а UI-контекст страниц и слотов плагина — `isInstanceAdmin` для
  отображения. Плагин может пускать к действию только администратора без
  собственного списка пользователей. Тестовый стенд SDK принимает
  `actor.isInstanceAdmin`. Вызовы данных актёра по-прежнему не несут.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| LICENSING (клиент) | `server/src/myrmidon/licensing/` (состояние лицензии по модулям, сохранение файла, доверенные ключи), экран `LicensesPage`/`LicensingSettingsPanel`, баннер `LicenseAttentionBanner`; монтирование каталога лицензии в установщике. В вендорских файлах — строки с маркером `myrmidon(LICENSING)`. | `server/src/app.ts` (параметр `licensingRoutes`), `ui/src/App.tsx` (маршрут), `ui/src/components/Layout.tsx`, `ui/src/components/Layout.production.tsx` (баннер), `ui/src/components/CompanySettingsSidebar.tsx`, `ui/src/components/CompanySettingsSidebar.production.tsx` (пункт меню) | Клиент запрашивает и устанавливает лицензию закрытых модулей в интерфейсе доски | `server/src/myrmidon/licensing/client-licensing.myrmidon.test.ts`, `ui/src/components/myrmidon/LicensingSettingsPanel.myrmidon.test.tsx`, `ui/src/components/myrmidon/LicenseAttentionBanner.myrmidon.test.tsx`, `scripts/myrmidon/install/install.test.mjs` | Убрать строки с маркером, файлы экрана и баннера, `client-license.ts` | этот PR |
| PLUGIN-INSTANCE-ADMIN | Флаг `isInstanceAdmin` в контексте актёра действия плагина и в UI-контексте плагина | `packages/plugins/sdk/src/protocol.ts`, `packages/plugins/sdk/src/worker-rpc-host.ts`, `packages/plugins/sdk/src/testing.ts`, `packages/plugins/sdk/src/ui/types.ts`, `server/src/routes/plugins.ts`, `ui/src/plugins/bridge.ts`, `ui/src/plugins/slots.tsx`; ожидания вендорских тестов `server/src/__tests__/plugin-routes-authz.test.ts`, `packages/plugins/sdk/tests/worker-rpc-host.test.ts`, `packages/plugins/sdk/tests/testing-actions.test.ts` дополнены полем | Плагин выпуска лицензий пускает только администратора инстанса, не держа ручной список | `packages/plugins/sdk/tests/worker-rpc-host.instance-admin.myrmidon.test.ts`, `server/src/__tests__/plugin-routes-authz.test.ts` | Убрать поле и строки с маркером | этот PR |

## settings-en

| `MYR_LICENSE_PATH` | LICENSING | `/etc/myrmidon-license/license.key` | The license file the closed modules read; the Licenses screen shows its state and saves into it. The installer sets it for the board and mounts the host directory read-write. | `MYR_LICENSE` (license text in the environment) overrides the file; the screen then only shows the state. |
| `MYRMIDON_LICENSE_DIR` (installer) | LICENSING | `/etc/myrmidon-license` | Host directory of the license file, mounted into the board read-write at `/etc/myrmidon-license`; owned by the board user (`MYRMIDON_BOARD_UID`, default `1000`). | — |

## settings-ru

| `MYR_LICENSE_PATH` | LICENSING | `/etc/myrmidon-license/license.key` | Файл лицензии, который читают закрытые модули; экран «Лицензии» показывает его состояние и сохраняет в него. Установщик задаёт его доске и монтирует каталог хоста на запись. | `MYR_LICENSE` (текст лицензии в окружении) перекрывает файл; экран тогда только показывает состояние. |
| `MYRMIDON_LICENSE_DIR` (установщик) | LICENSING | `/etc/myrmidon-license` | Каталог файла лицензии на хосте, монтируется в доску на запись в `/etc/myrmidon-license`; владелец — пользователь доски (`MYRMIDON_BOARD_UID`, по умолчанию `1000`). | — |
