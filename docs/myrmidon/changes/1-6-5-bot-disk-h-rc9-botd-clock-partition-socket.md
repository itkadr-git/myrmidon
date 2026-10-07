---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### botd plans with a Date clock; the bot partition is measured over the dockergate socket (1.6.5 BOT-DISK-H, rc.9)

- botd deleted nothing on the production host: the loop handed the rules a
  `Date` as the clock, the rules only accepted a number or a string, read it as
  "no time" and returned an empty plan without a word. The rules now accept a
  `Date` (finite check included) and the loop passes epoch milliseconds.
- The host-disk sweep never measured the bot partition on a host where
  dockergate listens on a unix socket only: the client was built only from
  `MYRMIDON_DOCKERGATE_URL` (TCP), so the pressure stayed `0 / none` and the
  log said "host disk usage could not be read" every five minutes. The sweep
  now takes its client from the same socket the docker driver uses
  (`MYRMIDON_BOT_DOCKER_SOCKET`); the TCP client is built only when
  `MYRMIDON_DOCKERGATE_URL` is set and no socket is configured. A failing gate is
  still "not measured", never an error in the sweep.
- botd now removes a directory named exactly like a task key under `/workspace` only when the board lists the key in the new `closedKeys` of the desired state (done/cancelled tasks the bot holds or held, no lookback limit); an open task that moved to review and is no longer assigned to the bot is only reported. Names that are not a key and `/scratch` follow the TTL as before.
- Operator note: `/cache/pnpm-store` is mounted read-write; the host source
  directory must belong to uid/gid 10001 (documented in the shared package cache
  steps).

## changelog-ru

### botd планирует с часами Date; раздел ботов меряется через сокет dockergate (1.6.5 BOT-DISK-H, rc.9)

- На боевом хосте botd ничего не удалял: цикл передавал правилам в качестве часов
  `Date`, правила принимали только число или строку, считали время неизвестным и
  молча возвращали пустой план. Правила теперь понимают `Date` (с проверкой на
  конечность), цикл передаёт миллисекунды.
- Свип диска хоста не измерял раздел ботов там, где dockergate слушает только
  unix-сокет: клиент строился лишь из `MYRMIDON_DOCKERGATE_URL` (TCP), поэтому
  давление оставалось `0 / none`, а в журнале каждые пять минут писалось «host disk
  usage could not be read». Теперь клиент берётся с того же сокета, что и docker-драйвер
  (`MYRMIDON_BOT_DOCKER_SOCKET`); TCP-клиент строится, только если задан
  `MYRMIDON_DOCKERGATE_URL` и сокет не задан. Недоступный шлюз — по-прежнему
  «не измерено», а не ошибка свипа.
- botd теперь удаляет каталог под `/workspace`, названный в точности как ключ задачи, только если доска перечислила ключ в новом поле `closedKeys` желаемого состояния (done/cancelled задачи бота, без ограничения по давности); открытая задача, ушедшая на ревью и уже не назначенная боту, только попадает в отчёт. Имена не-ключи и `/scratch` — по TTL, как раньше.
- Для оператора: `/cache/pnpm-store` монтируется на запись; исходный каталог на хосте
  должен принадлежать uid/gid 10001 (описано в шагах общего кэша пакетов).

## divergence

| 1.6.5-BOT-DISK-H-rc9 | botd передаёт правилам миллисекунды, а правила понимают `Date`; свип диска хоста берёт клиента dockergate по unix-сокету (`MYRMIDON_BOT_DOCKER_SOCKET`), TCP — только при заданном `MYRMIDON_DOCKERGATE_URL` | Наши файлы: `docker/bot-runtime/botd/lib/{loop,rules}.js`, `server/src/myrmidon/host-disk/{dockergate,index}.ts` и тесты. Маркеров вендора нет: все файлы наши | botd ничего не удалял (часы Date), давление раздела всегда 0/none (нет TCP-адреса dockergate на боевом хосте) | `botd-loop.test.mjs`, `botd-rules.test.mjs` (Date-часы, реальные правила), `partition-client.myrmidon.test.ts` (выбор клиента, юнит-сокет, соответствие процентов) | Никогда, наше поведение | (этот PR) |
