## changelog-en

### OMP sandbox: omp_local supports local process confinement (1.6.7 OMP-HARDEN)

- The `omp_local` adapter now supports the same local process sandbox as
  `claude_local`/`codex_local`: `filesystemScope: "workspace"` (Bubblewrap
  workspace-only filesystem), `networkScope: "deny" | "allowlist"` with
  `networkAllowlist`, `filesystemExtraPaths`, and `filesystemSandboxCommand`
  (default `bwrap`). With neither scope set, execution stays unsandboxed.
- The omp session directory (`--session-dir`, `~/.omp/paperclips/<companyId>/<agentId>`)
  and the managed agent-config directory (`models.yml`, skills) are mounted
  read/write inside the sandbox; the configured control-plane API URL is
  trusted for the adapter's runtime connection.
- New `omp_local` agents default to `filesystemScope: "workspace"` in the
  create form; the Agent Settings form now shows the shared sandbox and
  network fields for `omp_local` (no timeout keys — the adapter reads none).
- Sandbox keys of `omp_local` are validated on save and gated as a security
  change: editing them requires an instance admin, same as `claude_local`/`codex_local`.
- Bubblewrap that cannot create a Linux user namespace now fails the launch
  with an explicit error before the agent process starts; the process is never
  started without the requested confinement.
- The default `--tools` list was corrected for omp 18.9.2 built-ins
  (`read,bash,edit,write,grep`; `ls` is a hard error and `find` needs the `fd`
  binary) and is configurable via adapter `tools`.

## changelog-ru

### Песочница OMP: omp_local поддерживает локальную изоляцию процесса (1.6.7 OMP-HARDEN)

- Адаптер `omp_local` теперь поддерживает ту же локальную песочницу процесса,
  что и `claude_local`/`codex_local`: `filesystemScope: "workspace"`
  (файловая граница Bubblewrap только на workspace), `networkScope: "deny" | "allowlist"`
  с `networkAllowlist`, `filesystemExtraPaths` и `filesystemSandboxCommand`
  (по умолчанию `bwrap`). Если не задан ни один scope, выполнение остаётся
  без песочницы.
- Каталог сессий omp (`--session-dir`, `~/.omp/paperclips/<companyId>/<agentId>`)
  и управляемый каталог конфигурации агента (`models.yml`, skills) монтируются
  внутрь песочницы на запись; сконфигурированный URL API control plane доверен
  для runtime-соединения адаптера.
- Новые агенты `omp_local` по умолчанию получают `filesystemScope: "workspace"`
  в форме создания; в форме настроек агента для `omp_local` появились общие
  поля песочницы и сети (без полей таймаутов — адаптер их не читает).
- Ключи песочницы `omp_local` проверяются при сохранении и считаются изменением
  настроек безопасности: правка требует администратора инстанса, как и для
  `claude_local`/`codex_local`.
- Bubblewrap, который не может создать Linux user namespace, теперь завершает
  запуск явной ошибкой до старта процесса агента; процесс никогда не запускается
  без запрошенной изоляции.
- Список `--tools` по умолчанию исправлен под встроенные инструменты omp 18.9.2
  (`read,bash,edit,write,grep`; `ls` — жёсткая ошибка, `find` требует бинарник
  `fd`) и настраивается через `tools` конфигурации адаптера.
