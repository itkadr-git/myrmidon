## changelog-en
### Dockergate poll storm removed (OPE-4789, second half of OPE-4752)

The board talked to dockergate far more than the planned once-a-minute sweep:
~30 requests/s on a 74-bot fleet, hour-and-a-half rollouts, 28 refusals.

- The clone-report collector runs at most once a minute and asks only about
  running bots.
- One reconcile pass costs one inspect and one marker read; the create-body
  template context is cached 60 s per bot instead of re-read three times.
- The health wait after a start polls every 3 s, matching the image's 30 s
  HEALTHCHECK cadence.
- A duplicated apply within 30 s answers from freshness; real changes (Apply
  now, secret rotation, canary wave) pass `force: true` and always run.
- A 429 is retried by the call that got it — after `Retry-After` or a capped
  backoff (1/2/4/8 s, max 4 attempts) — not by every caller at once.

Measured on the fake daemon: a plain sweep costs 2 gate requests (was 3+), a
canary-overlapped pass 2 (was 6).
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
