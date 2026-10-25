---

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
