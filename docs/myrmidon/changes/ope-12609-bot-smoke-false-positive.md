---
settings-section: Track 5 — operations
---

## changelog-en

### OPE-12609: fix false DEPLOYED-DEGRADED on idle-stopped, stale OOM and transient unhealthy bots

- Corrected bot classification in `bot-apply-smoke.sh` during post-deploy verification to prevent false `DEPLOYED-DEGRADED` results (rc.17 and rc.19 incidents):
  - Missing runtime container ("No such container", absent docker inspect output) for an agent without a board error is classified as `idle_stopped` rather than an active unhealthy gateway, excluding it from the active smoke denominator. Empty inspect fields now normalize to `missing` rather than printing `docker:`.
  - `OOMKilled=true` is counted as a deployment casualty only if the container's `FinishedAt` timestamp is inside the deployment window (`>= --deploy-started-at`). Stale OOM killed containers from before the deployment window are excluded as pre-deploy `idle_stopped`.
  - Docker or board `unhealthy` mark is evaluated on the current poll via an active `/health` probe response (`docker exec … curl /health`); bots whose gateways recovered by the end of the maintenance window pass as `healthy` instead of failing the deploy with a sticky `crashed:docker_unhealthy`.
  - Genuine exits, in-window OOMs, and dead gateways continue to produce `DEPLOYED-DEGRADED`.

## changelog-ru

### OPE-12609: устранение ложного DEPLOYED-DEGRADED при погашенных ботах, старом OOM и временном unhealthy

- Исправлена классификация ботов в `bot-apply-smoke.sh` при послевыкатной проверке, исключающая ложный статус `DEPLOYED-DEGRADED` (инциденты на rc.17 и rc.19):
  - Отсутствующий runtime-контейнер («No such container») у агента без ошибки на доске классифицируется как `idle_stopped`, а не активный нездоровый шлюз, и исключается из знаменателя активных ботов. Пустые поля inspect теперь нормализуются в `missing`, устраняя статус `docker:`.
  - Флаг `OOMKilled=true` считается падением выката только если время остановки контейнера `FinishedAt` находится внутри окна выката (`>= --deploy-started-at`). Старые OOM-контейнеры до начала выката исключаются как `idle_stopped`.
  - Статус `unhealthy` (docker или доски) проверяется по текущему отклику шлюза на пробу `/health` (`docker exec … curl /health`); боты, восстановившиеся к концу окна обслуживания, признаются `healthy`, не вызывая ложного `crashed:docker_unhealthy`.
  - Реальные падения (ненулевой exit/OOM внутри окна, не отвечающий шлюз) по-прежнему вызывают `DEPLOYED-DEGRADED`.
