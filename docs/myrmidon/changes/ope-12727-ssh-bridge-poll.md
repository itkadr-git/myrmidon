## changelog-en

### The bridge queue poller blocks remotely instead of spawning an ssh process per poll (OPE-12727)

- In SSH environments the bridge worker polled the request queue every 100 ms, and each poll spawned a fresh `ssh` process; under load the board spent ~30% of a core in `spawn` alone. One poll now blocks inside the remote shell until a request appears or five seconds elapse, so an idle bridge costs one exec per five seconds instead of ~10 per second. `MYRMIDON_BRIDGE_QUEUE_POLL_IDLE_MS` (legacy `PAPERCLIP_BRIDGE_QUEUE_POLL_IDLE_MS`) tunes the budget; `0` restores the old per-poll behavior.

## changelog-ru

### Опрос очереди моста блокируется удалённо вместо запуска ssh-процесса на каждый опрос (OPE-12727)

- В SSH-окружениях воркер моста опрашивал очередь запросов каждые 100 мс, и каждый опрос запускал новый `ssh`-процесс; под нагрузкой доска тратила ~30% ядра только на `spawn`. Теперь один опрос блокируется в удалённом шелле, пока не появится запрос или не истечёт пять секунд, поэтому простаивающий мост обходится одним exec раз в пять секунд вместо ~10 в секунду. Бюджет настраивается через `MYRMIDON_BRIDGE_QUEUE_POLL_IDLE_MS` (легаси `PAPERCLIP_BRIDGE_QUEUE_POLL_IDLE_MS`); `0` возвращает старое поведение.
