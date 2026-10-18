---
settings-section: 1.6.6 — SETTINGS-UI B: screen bot-disk lifecycle (`general.botDisk`, stored)
---

## settings-en-append

<!-- section: Трек 3 — шлюз инструментов и адаптер Hermes -->

Isolation is opt-in per agent in the Hermes adapter configuration (`adapterConfig`), not an instance-wide environment switch. With neither `filesystemScope` nor `networkScope`, execution remains unsandboxed. Set `filesystemScope: "workspace"` to use a Bubblewrap workspace-only filesystem boundary. `filesystemSandboxCommand` selects the executable (default `bwrap`), and `filesystemExtraPaths` lists additional paths the sandbox may expose. For network control, set `networkScope: "deny"` or `"allowlist"` with `networkAllowlist` containing permitted hosts/origins. The Paperclip API URL is trusted for the adapter's runtime connection. These settings affect `hermes_local` only; Bubblewrap must be installed on the agent host.

## settings-ru-append

<!-- section: Track 3 — tool gateway and Hermes adapter -->
### Изоляция процесса `hermes_local`

Изоляция включается отдельно для агента в конфигурации адаптера Hermes (`adapterConfig`), а не переменной окружения инстанса. Если не заданы `filesystemScope` и `networkScope`, выполнение остаётся без песочницы. Задайте `filesystemScope: "workspace"` для границы Bubblewrap только на workspace. `filesystemSandboxCommand` выбирает исполняемый файл (по умолчанию `bwrap`), а `filesystemExtraPaths` перечисляет дополнительные доступные песочнице пути. Для сети задайте `networkScope: "deny"` или `"allowlist"` вместе с `networkAllowlist`, содержащим разрешённые хосты/origin. URL API Paperclip доверен для runtime-соединения адаптера. Эти настройки действуют только на `hermes_local`; Bubblewrap должен быть установлен на хосте агента.