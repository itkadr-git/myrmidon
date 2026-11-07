---
settings-section: Track 5 — operations
---

## changelog-en

### LiteLLM workers card: planned restart instead of gunicorn signals, real `current` and working metrics (OPE-8899)

- The gateway runs as `litellm --num_workers N`, not under gunicorn, so the TTIN/TTOU
  signals never applied. `apply.path` is now `restart`: `PUT .../litellm/workers` stores the
  target, runs the instance's restart command (`MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND`,
  `{workers}` is the target) and then reads the pool size back; `applied` is true only when
  it equals the target. Nothing is restarted unless the command is configured, and a pool
  already at its measured target is not restarted. The card warns that requests are briefly
  dropped before the operator confirms. `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` and
  `MYRMIDON_LITELLM_WORKERS_CONTAINER` are removed.
- `current` is no longer null on such a gateway: it is taken from the gateway's own pool
  gauge or, when the exposition names none (Prometheus in multiprocess mode), from the
  `--num_workers` of the gateway unit file (`MYRMIDON_LITELLM_WORKERS_UNIT_FILE`, read-only,
  `currentSource: launch_line`).
- Metrics read `reachable=false` with HTTP 401 because the board sent the secret NAME as the
  bearer token and asked for `/metrics`, which the gateway redirects. The key is now resolved
  from the company secret store (the cost-reader secret, else the admin one) and the request
  goes to `/metrics/`.

## changelog-ru

### Карточка воркеров LiteLLM: плановый рестарт вместо сигналов gunicorn, настоящий `current` и рабочие метрики (OPE-8899)

- Шлюз запущен как `litellm --num_workers N`, а не под gunicorn, поэтому сигналы TTIN/TTOU
  не применялись. Теперь `apply.path` равен `restart`: `PUT .../litellm/workers` сохраняет
  цель, запускает команду рестарта экземпляра (`MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND`,
  `{workers}` — цель) и затем сам читает число процессов; `applied` истинно, только если оно
  равно цели. Пока команда не задана, ничего не перезапускается; пул, уже равный измеренной
  цели, не перезапускается. Карточка до подтверждения предупреждает о коротком обрыве
  запросов. Переменные `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` и
  `MYRMIDON_LITELLM_WORKERS_CONTAINER` удалены.
- `current` на таком шлюзе больше не null: берётся из собственного gauge пула шлюза, а если
  экспозиция его не содержит (Prometheus в multiprocess-режиме) — из `--num_workers` юнита
  шлюза (`MYRMIDON_LITELLM_WORKERS_UNIT_FILE`, только чтение, `currentSource: launch_line`).
- Метрики давали `reachable=false` и HTTP 401: доска отправляла в Bearer ИМЯ секрета и
  обращалась к `/metrics`, который шлюз перенаправляет. Теперь ключ берётся из хранилища
  секретов компании (секрет cost-reader, иначе админский), а запрос идёт на `/metrics/`.

## settings-en

| `MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND` | LITELLM-WORKERS | unset | Command that restarts the gateway with a new pool size; the board runs it when the target changes and then confirms the result itself. Unset: the board only stores the target | A command with a `{workers}` placeholder |
| `MYRMIDON_LITELLM_WORKERS_UNIT_FILE` | LITELLM-WORKERS | `/etc/systemd/system/litellm-gateway.service` | The gateway unit the board reads (read-only) for the actual `--num_workers` | A path the board can read |

## settings-ru

| `MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND` | LITELLM-WORKERS | не задан | Команда планового рестарта шлюза с новым числом процессов; доска запускает её при смене цели и сама проверяет результат. Не задана: доска только сохраняет цель | Команда с подстановкой `{workers}` |
| `MYRMIDON_LITELLM_WORKERS_UNIT_FILE` | LITELLM-WORKERS | `/etc/systemd/system/litellm-gateway.service` | Юнит шлюза: из него доска читает фактический `--num_workers` (только чтение) | Путь к файлу, доступному доске на чтение |

## settings-en-replace

| `MYRMIDON_LITELLM_WORKERS_CONTAINER` | LITELLM-WORKERS A | removed | Removed in OPE-8899: no longer read (the pool is not resized by signals) | Not applicable |
| `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` | LITELLM-WORKERS A | removed | Removed in OPE-8899: replaced by `MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND` | Not applicable |

## settings-ru-replace

| `MYRMIDON_LITELLM_WORKERS_CONTAINER` | LITELLM-WORKERS A | удалена | Удалена в OPE-8899: больше не читается (число процессов не меняется сигналами) | Не применимо |
| `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` | LITELLM-WORKERS A | удалена | Удалена в OPE-8899: заменена на `MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND` | Не применимо |
