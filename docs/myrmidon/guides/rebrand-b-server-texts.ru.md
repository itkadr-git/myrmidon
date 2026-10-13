# Ребренд B: тексты сервера, установщик, вывод CLI, сообщения API

Гайд описывает проход 1.7 REBRAND B (задача OPE-4155): пользовательские тексты
сервера и CLI называют продукт **Myrmidon**. Имя вендора остаётся только в
лицензионном уведомлении, файле сторонних уведомлений и строке атрибуции
«Based on Paperclip (MIT)».

## Что изменилось

- **`--help` и баннер CLI.** `paperclipai --help` и справка всех подкоманд
  описывают «Myrmidon». Стартовый баннер печатает вывеску Myrmidon. Имя
  функции (`printPaperclipCliBanner`) и путь модуля
  (`cli/src/utils/banner.ts`) сохранены вендорскими для переносимости.
- **Сообщения CLI.** Онбординг, doctor, менеджер сервиса, update, worktree,
  test-drive, справка клиентских подкоманд, ошибки HTTP-клиента и подсказки
  проверок doctor используют имя продукта из одной константы,
  `cli/src/myrmidon-product.ts` (`PRODUCT_NAME`).
- **Ответы API об ошибках и описания.** `summary`/`description` OpenAPI,
  тексты ошибок маршрутов, ошибки валидации конфига, сообщения сверки
  workspace, подсказки провайдеров секретов называют Myrmidon (константа
  сервера: `server/src/myrmidon/product.ts`).
- **Onboarding-документы для внешних агентов** (`routes/access.ts`) называют
  Myrmidon в видимом тексте.
- **User-agent исходящих запросов** (например, `Paperclip/1.0` →
  `Myrmidon/1.0`).
- **Предупреждение о версии Node** (`packages/shared/src/node-version.ts`):
  префикс `[myrmidon]`, строка перезапуска — Myrmidon.
- **Wordmark в SVG орг-диаграмм.**

## Что НЕ изменилось (поверхность совместимости)

- Имя пакета `paperclipai`, bin `paperclipai` и слеш-команда `/paperclip`
  в Discord.
- Переменные окружения (`PAPERCLIP_*`), заголовки (`X-Paperclip-*`), пакеты
  `@paperclipai/*`, пути API, тип адаптера `paperclip_runner`.
- Пути состояния `~/.paperclip`.
- Имена MCP-серверов «Paperclip connections» и «Paperclip projects» — это
  ключи идентичности сессии, которые используют адаптеры; одно переименование
  сбросило бы каждую native-сессию.
- Замороженные снапшоты до переименования (`priorCloseCopyDefinition`,
  `preBrandingDefinition`, тела `LEGACY_*`) — они распознают данные,
  записанные до переименования.
- Внешние сервисы вендора: Paperclip Cloud, Paperclip Labs, Paperclip EE,
  Paperclip Enterprise.
- Атрибуция MIT «Based on Paperclip (MIT)».

## Где живёт имя продукта

| Поверхность | Константа |
| --- | --- |
| UI | `ui/src/lib/myrmidon-product.ts` |
| Тексты сервера | `server/src/myrmidon/product.ts` |
| Тексты CLI | `cli/src/myrmidon-product.ts` |
| Общее предупреждение о версии Node | литерал в `packages/shared/src/node-version.ts` (связан тестами) |

Тест-сторож в каждой области падает, если копии разойдутся.

## Тесты-сторожи

- `cli/src/__tests__/cli-product.myrmidon.test.ts` — баннер и синхронизация
  константы с серверным модулем.
- `server/src/__tests__/server-user-text.myrmidon.test.ts` — скан изменённых
  файлов сервера на имя вендора вне аллоулиста и проверка сгенерированного
  OpenAPI (кроме атрибуции, имён Cloud-сервиса и полей контракта). Скан
  OpenAPI живёт здесь, а не в CLI-сьюте, чтобы typecheck CLI не тянул
  серверные модули.

## Настроек нет

Проход меняет только текст. Настроек и изменений поведения он не вводит;
в `docs/myrmidon/SETTINGS.md` ничего не добавляется.
