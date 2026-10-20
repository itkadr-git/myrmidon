---
settings-section: Track 5 — operations
---

## changelog-en

### Server and CLI texts renamed to Myrmidon (REBRAND B, OPE-4155)

- User-visible text in the server and the CLI names the product Myrmidon:
  CLI `--help` and banner, onboarding/doctor/service/update messages, CLI
  HTTP client errors, OpenAPI summaries and descriptions, API error
  messages, onboarding documents for external agents, outgoing request
  user agents, the Node version warning, and the org-chart SVG wordmark.
  Details: [guides/rebrand-b-server-texts.md](guides/rebrand-b-server-texts.md).
- New guard tests keep the surfaces free of the vendor name:
  `cli/src/__tests__/cli-product.myrmidon.test.ts` and
  `server/src/__tests__/server-user-text.myrmidon.test.ts`.
- Identifiers are untouched for compatibility: the `paperclipai` package and
  bin, `PAPERCLIP_*` env vars, `X-Paperclip-*` headers, `@paperclipai/*`
  packages, `~/.paperclip` paths, MCP server names, the `/paperclip` Discord
  command, and frozen pre-rename snapshots.

## changelog-ru

### Тексты сервера и CLI переименованы в Myrmidon (REBRAND B, OPE-4155)

- Пользовательские тексты сервера и CLI называют продукт Myrmidon:
  `--help` и баннер CLI, сообщения онбординга/doctor/сервиса/update,
  ошибки HTTP-клиента CLI, summary и description OpenAPI, тексты ошибок API,
  onboarding-документы для внешних агентов, user-agent исходящих запросов,
  предупреждение о версии Node и wordmark в SVG орг-диаграмм. Подробности:
  [guides/rebrand-b-server-texts.ru.md](guides/rebrand-b-server-texts.ru.md).
- Новые тесты-сторожи держат поверхности без имени вендора:
  `cli/src/__tests__/cli-product.myrmidon.test.ts` и
  `server/src/__tests__/server-user-text.myrmidon.test.ts`.
- Идентификаторы не тронуты ради совместимости: пакет и bin `paperclipai`,
  env `PAPERCLIP_*`, заголовки `X-Paperclip-*`, пакеты `@paperclipai/*`,
  пути `~/.paperclip`, имена MCP-серверов, слеш-команда `/paperclip`
  в Discord и замороженные снапшоты до переименования.

## settings-en

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | empty | Comma-separated knowledge sections eligible for automatic acceptance by the distiller | Unset — no sections are auto-accepted |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | empty | OpenAI-compatible free-model gateway URL used by the distiller | Unset — the distiller cannot call a gateway |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Interval between distiller passes | Invalid or non-positive values use 86400 seconds |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | empty | Name of the company secret containing the distiller gateway key | Unset — no gateway key is available |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | implementation default | Maximum distiller pass duration in seconds | Invalid or non-positive values use the built-in default |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | implementation default | Maximum input-token budget for one distiller pass | Invalid or non-positive values use the built-in default |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | 150 | Maximum tasks collected by one distiller pass | Invalid or non-positive values use 150 |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | free | Model name sent to the distiller gateway | Unset — uses the free-model default |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Lookback window for distiller input in seconds | Invalid or non-positive values use 86400 seconds |

## settings-ru

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | пусто | Разделы знаний, перечисленные через запятую, для автоматического принятия дистиллятором | Не задано — автоматическое принятие отключено |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | пусто | URL OpenAI-совместимого шлюза бесплатной модели для дистиллятора | Не задано — дистиллятор не вызывает шлюз |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Интервал между проходами дистиллятора в секундах | Некорректное или неположительное значение заменяется на 86400 |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | пусто | Имя секрета компании со шлюзовым ключом дистиллятора | Не задано — шлюзовой ключ недоступен |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | по реализации | Максимальная длительность прохода дистиллятора в секундах | Некорректное или неположительное значение заменяется встроенным значением |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | по реализации | Максимальный бюджет входных токенов одного прохода | Некорректное или неположительное значение заменяется встроенным значением |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | 150 | Максимум задач в одном проходе дистиллятора | Некорректное или неположительное значение заменяется на 150 |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | free | Имя модели, передаваемое шлюзу дистиллятора | Не задано — используется бесплатная модель по умолчанию |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Окно входных данных дистиллятора в секундах | Некорректное или неположительное значение заменяется на 86400 |

## divergence-new

<!-- after: 1.6.5 — PERF-DIET G2: список агентов без adapter_config -->

### 1.7 — REBRAND B: тексты сервера, установщик и вывод CLI

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.7-RB | Пользовательские тексты (не идентификаторы) сервера и CLI называют Myrmidon: вывод `--help` и баннер CLI (ASCII-вывеска Myrmidon; имя экспорта `printPaperclipCliBanner` и имя модуля `cli/src/utils/banner.ts` сохранены для переносимости вендора), описания опций и подкоманд `paperclipai`, сообщения онбординга/doctor/сервиса, тексты ошибок HTTP-клиента CLI, страницы OAuth-возврата и завершения Cloud-регистрации (`tool-access.ts`), дескрипшены OpenAPI (все `summary`/`description`, кроме `Paperclip Cloud`), тексты onboarding-документа внешним агентам (`routes/access.ts`), промпты встроенных агентов, тексты ошибок API (`config-file.ts`, `workspace-runtime.ts`, `environments.ts`, `execution-workspaces.ts`, `secrets.ts`, `aws-secrets-manager-provider.ts`, `vercel-connect.ts`, `company-portability.ts`, `provider-profile.ts`, `runtime-mode.ts`, `runner-api-client.ts`, `private-hostname-guard.ts` и др.), user-agent'ы исходящих запросов (`Paperclip/1.0` → `Myrmidon/1.0` и т.п.), логи старта сервера, git-коммит «dirty workspace rescue», SVG орг-диаграмм (`org-chart-svg.ts` — wordmark), конфиг-валидация. Константа имени CLI: `+ cli/src/myrmidon-product.ts` (связана с серверной тестом `cli-product.myrmidon.test.ts`); имя продукта в shared-литерале `packages/shared/src/node-version.ts` (клиент и сервер грузят этот модуль — общая точка). Не переименованы (идентификаторы/совместимость): пакет `paperclipai` и bin, env `PAPERCLIP_*`, пути `~/.paperclip`, заголовки `X-Paperclip-*`, `@paperclipai/*`, тип `paperclip_runner`, имена MCP-серверов «Paperclip connections/projects» (метка `myrmidon(B1)` в `heartbeat.ts`), слеш-команда `/paperclip`, замороженные снапшоты `priorCloseCopyDefinition`/`preBrandingDefinition`, внешние сервисы `Paperclip Cloud`/`Labs`/`EE`/`Enterprise`, атрибуция «Based on Paperclip (MIT)» | `cli/src/index.ts`, `cli/src/utils/banner.ts`, `cli/src/commands/{run,service,install,uninstall,update,onboard,test-drive,worktree,managed-agent,channels,allowed-hostname,auth-bootstrap-ceo,env-lab,routines}.ts`, `cli/src/commands/client/{agent,common,context,company,connect,feedback,plugin,prompt,secrets,teams,token}.ts`, `cli/src/checks/{agent-jwt-secret-check,deployment-auth-check,managed-install-check,secrets-check,service-health-check}.ts`, `cli/src/prompts/secrets.ts`, `cli/src/client/http.ts`, `cli/src/services/service-manager.ts`, `cli/src/onboard-service.ts`, `cli/src/config/env.ts`, `packages/shared/src/node-version.ts`, `server/src/{config-file,index,worktree-config}.ts`, `server/src/middleware/private-hostname-guard.ts`, `server/src/adapters/{registry,hermes-gateway-doc}.ts`, `server/src/routes/{access,agents,board-chat,environments,execution-workspaces,llms,openapi,org-chart-svg,plugins,project-tools,projects,tool-access,tool-gateway}.ts`, `server/src/secrets/{aws-secrets-manager-provider,external-stub-providers}.ts`, `server/src/services/{agent-assigned-tools,agents,built-in-agents,chat-github-attachments,chat-sdk-runtime,chat-telegram-ephemeral,company-portability,company-skills,decision-signing,environments,execution-workspaces,heartbeat,native-runtime/*,photon/adapter,plugin-loader,remote-http-fetch,runner-goals,secrets,tool-access,tool-gateway,vercel-connect,workspace-runtime}.ts`; обновлены тесты вендора, проверяющие текст: `cli/src/node-version.test.ts`, `cli/src/__tests__/{feedback,http,service-health-check,worktree}.test.ts`; + `cli/src/myrmidon-product.ts`, `cli/src/__tests__/cli-product.myrmidon.test.ts`, `server/src/__tests__/server-user-text.myrmidon.test.ts` | B1 (ROADMAP 1.7, OPE-4155): имя вендора остаётся только в LICENSE, NOTICE и строке «Based on … (MIT)» | `cli/src/__tests__/cli-product.myrmidon.test.ts` (имя, баннер, OpenAPI без «Paperclip» кроме атрибуции/Cloud/полей контракта), `server/src/__tests__/server-user-text.myrmidon.test.ts` (скан изменённых файлов на «Paperclip» вне аллоулиста) | Никогда, наше имя продукта. При переносе вендора: новый видимый текст с «Paperclip» в этих файлах переименовать в `${PRODUCT_NAME}`, а не добавлять в аллоулист; аллоулист — только атрибуция, внешние сервисы, идентификаторы, замороженные снапшоты | (этот PR) |
