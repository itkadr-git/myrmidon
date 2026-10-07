## changelog-en

### Dockergate poll storm removed (OPE-4789, second half of OPE-4752)

The board's container layer talked to dockergate far more often than the
planned once-a-minute sweep: the clone-hygiene report collector rode the 5 s
maintenance tick (per-bot inspect + archive read per tick), the reconciler
paid two inspects per bot per pass (status and the drift check each read
their own), the drift check re-read the shared-cache/scope settings three
times per pass, the health wait after a start polled inspect once a second
while the image's own HEALTHCHECK runs every 30 s, a canary wave pass and
the sweep pass for the same bot duplicated each other, and a 429 from the
gate was a terminal error every caller retried at once. On a 74-bot fleet
this summed to ~30 requests/s against the gate's global limit and 1.5-hour
fleet rollouts with 28 refusals.

- The clone-report collector runs at most once a minute now (the reports
  feed hourly-TTL attention signals; nothing an operator can act on is
  lost) and asks the driver for running bots only, so a stopped bot's
  inspect+marker pair is not paid on every pass.
- One reconcile pass costs one inspect and one marker read: the drift check
  reuses the inspect the status read already paid for
  (`BotContainerStatus.inspect`), and the template context behind the
  create body (shared package cache path, git-mirror flag, scope layout) is
  cached per bot for 60 s instead of being re-read three times per pass.
- The health wait after a (re)start polls every 3 s, matching the image's
  own 30 s HEALTHCHECK cadence instead of polling 30× between two verdict
  changes.
- A second `applyBotContainerNow` for one bot within 30 s of a pass
  (sweep × canary wave tick) is answered from freshness instead of
  re-reading everything; the card's "Apply now" button, secret-rotation
  restarts and the canary wave itself pass `force: true` and always run a
  real pass — a rollout asks for a change by definition, so the window
  must not answer it from freshness and mark the bot done on the old
  image. A pass that
  errored never stamps, so a transient docker failure is retried on the
  next tick.
- A 429 from dockergate is retried by the call that got it — after the
  gate's `Retry-After` hint when one arrives, otherwise after a growing
  backoff (1 s, 2 s, 4 s, capped at 8 s, at most 4 attempts) — instead of
  failing the pass into an immediate caller retry.

Measured on the fake daemon (docker-driver.myrmidon.test.ts, OPE-4789
suite): an unchanged sweep pass over one bot costs 2 dockergate requests
(was 3+), a canary-overlapped pass costs the same 2 (was 6), and a burst
that hits the gate's limit resolves in place instead of multiplying.

## changelog-ru

### Шторм опроса dockergate убран (OPE-4789, вторая половина OPE-4752)

Доска опрашивала dockergate заметно чаще планового обхода раз в минуту:
сборщик clone-отчётов ехал на тике maintenance (5 с) — inspect и чтение
архива на бота за тик; пряжка reconciler'а платила два inspect на бота
(статус и проверка дрейфа читали свой); проверка дрейфа перечитывала
настройки кэша/скоупа трижды за пряжку; ожидание здоровья после старта
опрашивало inspect раз в секунду при HEALTHCHECK образа раз в 30 с; пряжка
волны канареи и пряжка обхода одного бота дублировали друг друга; а 429 от
гейта был терминальной ошибкой, которую каждый вызывающий повторял сразу.
На флоте из 74 ботов это давало ~30 запросов/с в глобальный лимит гейта и
полуторачасовой выкат с 28 отказами.

- Сборщик clone-отчётов работает не чаще раза в минуту (отчёты питают
  сигналы с TTL в час — оператор ничего не теряет) и спрашивает у драйвера
  только работающих ботов: остановленный бот не оплачивает inspect+метку
  каждый проход.
- Одна пряжка reconciler'а стоит один inspect и одно чтение метки: проверка
  дрейфа переиспользует inspect из уже прочитанного статуса
  (`BotContainerStatus.inspect`), а контекст шаблона (путь общего кэша,
  флаг git-зеркал, скоуп) кэшируется на бота на 60 с вместо тройного
  перечитывания за пряжку.
- Ожидание здоровья после (пере)старта опрашивает раз в 3 с — под cadence
  собственного HEALTHCHECK образа (30 с), а не 30 опросов между двумя
  сменами вердикта.
- Второй `applyBotContainerNow` одного бота в течение 30 с после пряжки
  (обход × тик волны канареи) отвечается из свежести без новых чтений;
  кнопка «Apply now», рестарты ротации секретов и сама волна канареи идут
  с `force: true` и всегда делают настоящую пряжку — выкат по определению
  просит изменение, и окно не должно отвечать ему из свежести, помечая
  бота «готовым» на старом образе. Пряжка с ошибкой не отмечается —
  следующий тик её повторяет.
- 429 от dockergate повторяется самим запросом: по `Retry-After` гейта, а
  без него — с нарастающей паузой (1 с, 2 с, 4 с, потолок 8 с, не более 4
  попыток) вместо немедленного повтора вызывающим.

Замер на фейковом демоне (docker-driver.myrmidon.test.ts, набор OPE-4789):
неизменная пряжка обхода стоит 2 запроса к dockergate (было 3+), пряжка с
перекрытием канареи — те же 2 (было 6), а всплеск в лимит гейта
разрешается на месте, а не размножается.
