---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### DEVBUILD-IN-BOTS: env-delivered key, a start self-check and a local heavy-run fallback (DEVBUILD-IN-BOTS)

- The `devbuild` CLI accepts the build-server key as the secret env
  `DEVBUILD_SSH_KEY_DATA` (the key text itself) when the
  `/opt/devbuild-ssh/id_ed25519` file is not mounted — this is how the board
  hands the key to a bot whose container has no mount. The key is
  materialized into a per-process private directory (0700 dir, 0600 file)
  under the run scratch — never into `/workspace` — and removed on exit. A
  readable key file still wins over the env key; the missing-everything error
  is unchanged.
- The bot entrypoint runs a devbuild self-check at start: when
  `DEVBUILD_HOST` is set it probes `devbuild 'true'` and logs one line
  (`devbuild self-check ok: …` or `ERROR: devbuild self-check failed: …`),
  plus a machine-readable `${HERMES_HOME}/.myrmidon/devbuild-check.json` for
  the board. The check never stops the gateway; bots without `DEVBUILD_HOST`
  stay silent; `MYRMIDON_DEVBUILD_CHECK=0` disables the probe.
- Heavy build commands that pass the devbuild gate (a build container, or a
  direct binary path in an ordinary bot container) now run with a
  container-safe heap cap: the wrappers append
  `--max-old-space-size=2048` (override `MYRMIDON_LOCAL_NODE_HEAP_MB`, `0`
  disables) to the child's `NODE_OPTIONS` — a caller's own
  `--max-old-space-size` wins — and print one stderr warning pointing at
  `devbuild`. Version/help probes skip both. This is the fallback that keeps
  an uncapped tsc from OOM-killing the bot container while the offload is
  being rolled out.

## changelog-ru

### DEVBUILD-IN-BOTS: ключ через env, самопроверка старта и потолок памяти для локальных тяжёлых запусков (DEVBUILD-IN-BOTS)

- `devbuild` принимает ключ сборочного VPS через секретный env
  `DEVBUILD_SSH_KEY_DATA` (текст ключа), когда файл
  `/opt/devbuild-ssh/id_ed25519` не смонтирован — так доска передаёт ключ боту
  без монтирования. Ключ материализуется в процессный приватный каталог
  (0700/0600) в run-scratch — никогда в `/workspace` — и удаляется при выходе.
  Читаемый файл ключа по-прежнему приоритетнее env; ошибка «ключа нет» не
  изменилась.
- Entrypoint бота при старте делает самопроверку devbuild: при заданном
  `DEVBUILD_HOST` выполняет `devbuild 'true'` и пишет одну строку в лог
  (`devbuild self-check ok: …` либо `ERROR: devbuild self-check failed: …`),
  плюс машиночитаемый `${HERMES_HOME}/.myrmidon/devbuild-check.json` для
  доски. Проверка никогда не останавливает gateway; боты без `DEVBUILD_HOST`
  молчат; `MYRMIDON_DEVBUILD_CHECK=0` отключает проверку.
- Тяжёлые команды, прошедшие гейт devbuild (сборочный контейнер или прямой
  путь к бинарю в обычном контейнере бота), теперь работают с потолком кучи:
  обёртки добавляют `--max-old-space-size=2048` (переопределение
  `MYRMIDON_LOCAL_NODE_HEAP_MB`, `0` — выкл) в `NODE_OPTIONS` ребёнка —
  собственный `--max-old-space-size` вызывающего побеждает — и печатают одно
  предупреждение в stderr с указанием на `devbuild`. Версионные пробы
  (version/help) не трогаются. Это предохранитель: некапнутый tsc больше не
  уронит контейнер бота по OOM, пока вынос сборок раскатывается.

## settings-en

| `MYRMIDON_DEVBUILD_CHECK` | DEVBUILD-IN-BOTS | `1` | Bot start self-check: with `DEVBUILD_HOST` set, the entrypoint probes `devbuild 'true'` and logs the outcome plus `${HERMES_HOME}/.myrmidon/devbuild-check.json`. Never fatal. `0` disables the probe | Dev-variant bots only; bots without `DEVBUILD_HOST` are silent either way |
| `MYRMIDON_LOCAL_NODE_HEAP_MB` | DEVBUILD-IN-BOTS | `2048` | Heap cap (MB) the build wrappers set on heavy commands that run inside the bot container (devbuild-gate pass-through or direct binary path). `0` disables the cap; a caller's own `--max-old-space-size` in `NODE_OPTIONS` always wins | Fallback for the rollout period; the fleet target stays 0 local tsc/vitest runs |

## settings-ru

| `MYRMIDON_DEVBUILD_CHECK` | DEVBUILD-IN-BOTS | `1` | Самопроверка старта бота: при заданном `DEVBUILD_HOST` entrypoint выполняет `devbuild 'true'` и пишет итог в лог и в `${HERMES_HOME}/.myrmidon/devbuild-check.json`. Никогда не фатальна. `0` отключает проверку | Только боты dev-варианта; боты без `DEVBUILD_HOST` молчат в любом случае |
| `MYRMIDON_LOCAL_NODE_HEAP_MB` | DEVBUILD-IN-BOTS | `2048` | Потолок кучи (МБ), который обёртки сборки ставят тяжёлым командам, идущим внутри контейнера бота (проход гейта devbuild или прямой путь к бинарю). `0` отключает потолок; собственный `--max-old-space-size` вызывающего в `NODE_OPTIONS` всегда побеждает | Предохранитель на период раскатки; цель флота — 0 локальных запусков tsc/vitest |
