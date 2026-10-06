# Настройки в интерфейсе

> English version: [Settings-in-the-interface](Settings-in-the-interface)

Где делается повседневная настройка доски. Источники: раздел «Настройка»
[README](https://github.com/itkadr-git/myrmidon/blob/main/README.ru.md) и
руководства оператора в
[`docs/myrmidon/guides/`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon/guides).

## Карта одним абзацем

Модели и агенты настраиваются в их карточках; матрица автономии и список
участников — в **настройках компании**; оболочка UI 2.0 — в **настройках
инстанса → Experimental**; язык доски (RU/EN) — у каждого пользователя на
экране «Язык и форматы» интерфейса 2.0. Переключатели функций, которые всё
ещё переменные окружения (`MYRMIDON_*`, все по умолчанию выключены),
перечислены в
[SETTINGS.ru.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.ru.md).

## Лимиты запусков (инстанс)

**Instance → General → секция «Run limits»** — меняются вживую, без
перезапуска сервера и без прерывания идущих прогонов
([run-limits](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/run-limits.ru.md)):

| Настройка | Что ограничивает | По умолчанию |
|---|---|---|
| `maxConcurrentRuns` | Сколько прогонов сервер держит в воздухе одновременно | выкл. |
| `maxStartsPerMinute` | Рампа старта: сколько прогонов может начаться за скользящую минуту | `5` (с 1.6.2) |
| `minFreeMemoryMb` | Свободная память в cgroup сервера, нужная для старта прогона | выкл. |
| `runMemoryEstimateMb` | Бюджет памяти одного прогона | `300` |
| `minFreeHostMemoryMb` | Свободная память хоста (`MemAvailable`), нужная для старта прогона | `15360` (15 ГБ, с 1.6.2) |

У каждого поля видно, откуда взялось действующее значение — сохранённая
настройка, переменная окружения или встроенное умолчание.

## Параллельные ходы агента

В карточке агента, раздел **Container**: политика планирования
(`runtimeConfig.heartbeat.maxConcurrentRuns`) задаёт, сколько прогонов этого
агента может быть активно одновременно; доска нормализует значение в
диапазон 1–50 и записывает его в конфиг шлюза бота. Карточка сравнивает то,
что просит доска, с тем, что реально применил шлюз бота, и помечает
расхождение
([bot-container-card](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/bot-container-card.ru.md)).

Рядом: **WIP-лимит** ограничивает, сколько задач агент держит в работе —
**Настройки компании → WIP limit**, живое значение видно в строке каждого
агента
([wip-limit](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/wip-limit.ru.md)).
Параметры очередей роя (TTL аренды, потолок активных задач на агента,
интервал обхода, вытеснение P0) правятся вживую в **Instance → General →
Очереди по ролям (SWARM-CLAIM)**
([swarm-claim-settings](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/swarm-claim-settings.ru.md)).

## Бэкапы

Политика хранения бэкапов БД живёт в общих настройках инстанса
(`instance_settings.general.backupRetention`): тиры день/неделя/месяц и — с
1.6.5 — необязательный флаг **«Хранить только последний бэкап»** на странице
общих настроек инстанса. Когда он включён, прогон бэкапа потоково
верифицирует новый дамп и только после этого удаляет прежние; дамп, не
прошедший верификацию, удаляется, старые бэкапы сохраняются, а прогон
завершается ошибкой с причиной
([журнал изменений](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/CHANGELOG.ru.md),
1.6.5 BACKUP-KEEP-LAST).

## Ещё в интерфейсе

- **Порог диска хоста** — Instance → General, «Host disk» (по умолчанию
  85 %); доска меряет заполнение диска хоста на каждом тике планировщика и
  поднимает сигнал внимания.
- **Квоты диска на бота** — панель «Per-bot disk quota» на странице общих
  настроек инстанса, с переопределениями в карточке агента.
- **Режим бюджетов** — только сигнал, пауза с карточкой владельцу или
  жёсткий отказ новых прогонов; ставится вживую на инстанс
  ([budget-enforcement](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/budget-enforcement.ru.md)).
