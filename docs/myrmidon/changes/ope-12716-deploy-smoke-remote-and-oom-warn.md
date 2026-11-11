## changelog-en

### 1.6.8 DEPLOY-SMOKE-REMOTE / DEPLOY-SMOKE-OOM-WARN: post-deploy bot smoke handles remote-host bots and single untouched OOM (OPE-12716)

- `scripts/myrmidon/deploy/bot-apply-smoke.sh`: bots pinned to another host (`adapterConfig.container.host != local`, e.g. the `work-*` bots on a remote VM) are verified by their own gateway — `apiBaseUrl` `/health` probe, board status as fallback — instead of local `docker`, which only answered "No such container" for them. Gateway diagnosis names the bot's host ("remote host <host>: логи на хосте") instead of "No such container".
- An in-window `OOMKilled` exit is a deploy casualty only when the rollout touched the container (it started inside the deploy window, i.e. re-created/restarted by the rollout) or two or more untouched containers OOMed (fleet-wide). A single OOM of a container untouched by the deploy is a `WARNING` (bot id + memory limit) and no longer fails the deploy (`rc.23` case).
- End-to-end coverage in `scripts/myrmidon/deploy/release-gate.test.mjs`: remote healthy bots classify healthy without local docker calls; single untouched OOM warns with exit 0; rollout-recreated OOM still fails the deploy; two untouched OOMs are a fleet casualty.

## changelog-ru

### 1.6.8 DEPLOY-SMOKE-REMOTE / DEPLOY-SMOKE-OOM-WARN: смок выката понимает ботов на другом хосте и одиночный OOM (OPE-12716)

- `scripts/myrmidon/deploy/bot-apply-smoke.sh`: боты, закреплённые за другим хостом (`adapterConfig.container.host != local`, например `work-*` на удалённой VM), проверяются по собственному шлюзу — зонд `apiBaseUrl` `/health`, при недоступности статус доски, — а не через локальный `docker`, который для них отвечал только «No such container». Диагностика называет хост бота («remote host <host>: логи на хосте») вместо «No such container».
- `OOMKilled` в окне выката — жертва выката только если роллаут трогал контейнер (контейнер стартовал в окне выката, то есть пересоздан/перезапущен роллаутом) или нетронутых OOM два и больше (весь флот). Одиночный OOM нетронутого контейнера — `WARNING` (id бота и лимит памяти) и больше не валит выкат (кейс `rc.23`).
- Сквозное покрытие в `scripts/myrmidon/deploy/release-gate.test.mjs`: здоровые удалённые боты классифицируются healthy без вызовов локального docker; одиночный нетронутый OOM — WARN с exit 0; OOM пересозданного роллаутом контейнера по-прежнему валит выкат; два нетронутых OOM — casualty флота.
