## changelog-en

### Instance → Features: every fork feature with its settings and live health (1.6.2 FEATURES)

- New page **Instance → Features** (`/company/settings/instance/features`, a "Features" entry in the
  settings sidebar and tab bar) and API `GET /api/myrmidon/features`. A registry of 14 fork features —
  swarm self-claim and idle wake, run admission, bot disk lifecycle, shared package cache, bot language
  servers, agent memory card, cost attribution sweep, Telegram DM status and progress, chat hold rules,
  budget enforcement, plugin entitlements, host disk signal, workspace quotas, model fallback signal —
  each with a name, a description, a guide link, the **effective configuration** (every value with its
  source: settings, server environment, default or derived, and the variable that forces it) and a link to
  its settings panel. The swarm self-claim and the bot disk lifecycle (which had no panel) carry an
  inline on/off switch (`PATCH /api/myrmidon/features/:key`, instance admin only; locked while an
  environment variable forces the value).
- **Live health per feature** from a small contract each module implements: status `working` / `off` /
  `misconfigured` / `failing`, last successful run, last error with the count over 24 hours, and one effect
  metric ("issues claimed in 24 h", "directories reaped in 24 h", "runs held in the queue now"). Built on
  data that already exists (activity log, run, publication, spend and budget tables, module state) plus a
  bounded in-process record of each timed sweep's passes. A module with no health signal — the bot
  language servers, and the chat hold rules while nothing was lifted — reports
  **`unknown — no health signal`**, never a fake `working`.
- **Attention signal**: a feature that is enabled and `misconfigured` or `failing` for more than 30 minutes
  raises one card in the attention queue (and clears when it recovers). The health pass runs every five
  minutes (`MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC`).
- The bot disk sweep now reports what it did (a volume root that cannot be listed, directories reaped,
  errors) instead of only logging, so a volume root that does not exist shows as `misconfigured` rather than
  failing on every pass unseen. See [guides/features-page.md](guides/features-page.md), [SETTINGS.md](SETTINGS.md).

## changelog-ru

### Instance → Features: каждая возможность форка с настройками и живым здоровьем (1.6.2 FEATURES)

- Новая страница **Instance → Features** (`/company/settings/instance/features`, пункт «Features» в боковой
  панели и во вкладках настроек) и API `GET /api/myrmidon/features`. Реестр из 14 возможностей форка —
  самозахват роя и побудка простаивающих, допуск запусков, жизненный цикл диска ботов, общий кэш пакетов,
  языковые серверы ботов, карточка памяти агента, сбор и привязка расходов, статус и ход работы в личном
  чате Телеграм, правила удержания чатов, контроль бюджета, ключи доступа к плагинам, сигнал о диске
  хоста, квоты рабочих областей, сигнал о подмене модели — у каждой название, описание, ссылка на
  руководство, **действующая настройка** (каждое значение с источником: настройки, окружение сервера,
  умолчание или вычислено, и переменная, которая его задаёт) и ссылка на панель настроек. У самозахвата
  роя и жизненного цикла диска ботов (у него панели не было) есть встроенный переключатель
  (`PATCH /api/myrmidon/features/:key`, только администратор экземпляра; заблокирован, пока значение
  задано переменной окружения).
- **Живое здоровье каждой возможности** по малому контракту, который реализует модуль: состояние `working` /
  `off` / `misconfigured` / `failing`, время последнего успешного прохода, последняя ошибка с числом за 24
  часа и одна метрика эффекта («задач захвачено за 24 ч», «каталогов удалено за 24 ч», «запусков держится в
  очереди сейчас»). Строится на уже существующих данных (журнал действий, таблицы запусков, публикаций,
  расходов и бюджета, состояние модулей) и на ограниченной записи проходов каждого обхода по таймеру в
  памяти процесса. Модуль без сигнала здоровья — языковые серверы ботов и правила удержания чатов, пока
  ничего не снималось, — сообщает **`unknown — no health signal`**, а не ложное `working`.
- **Сигнал во внимание**: возможность включена и `misconfigured` или `failing` дольше 30 минут — одна
  карточка в очереди внимания (исчезает, когда всё восстановилось). Проход здоровья идёт раз в пять минут
  (`MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC`).
- Обход диска ботов теперь сообщает, что сделал (каталог томов, который нельзя прочитать, удалено
  каталогов, ошибки), а не только пишет в журнал: несуществующий каталог томов виден как
  `misconfigured`, а не падает на каждом проходе незамеченным. См.
  [guides/features-page.ru.md](guides/features-page.ru.md), [SETTINGS.ru.md](SETTINGS.ru.md).

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### 1.6.2 — FEATURES: страница Instance → Features (реестр возможностей с живым здоровьем)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.2-FEATURES | Страница `Instance → Features` и API `GET /api/myrmidon/features`, `PATCH /api/myrmidon/features/:key`: реестр возможностей форка (ключ, название, описание, ссылка на руководство, действующая настройка с источником значения, ссылка на панель настроек или встроенный переключатель у самозахвата роя и жизненного цикла диска ботов) и живое здоровье каждой по малому контракту: состояние `working`/`off`/`misconfigured`/`failing`/`unknown`, время последнего успешного прохода, последняя ошибка и их число за 24 часа, одна метрика эффекта. Модуль без сигнала здоровья даёт `unknown — no health signal`, а не `working`. Здоровье берётся из того, что уже есть: журнал действий, таблицы запусков, публикаций, расходов и бюджета, состояние модулей; обходы без своей таблицы (диск ботов, сбор расходов, роевой обходчик, подмена модели, память агента, сверка контейнеров) сообщают проход в процессный регистр `features/recorder.ts` (в памяти, ограничен, теряется при перезапуске). Сигнал во внимание: возможность включена и `misconfigured`/`failing` дольше 30 минут — одна карточка `agent_error_alert` (дедуп `feature_health:<ключ>`), часы в процессе, проход здоровья раз в 5 минут (`MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC`). Обход диска ботов теперь возвращает отчёт (корень каталога томов нечитаем / удалено / ошибки) вместо `void`; ошибки по-прежнему логируются и не прерывают обход | Новые файлы: `packages/shared/src/myrmidon-features.ts`, `server/src/myrmidon/features/{types,recorder,health,reporters,ports,registry,service,attention,sweep,routes,index}.ts`, `server/src/myrmidon/features/definitions/*.ts`, `server/src/myrmidon/features/{features,routes}.myrmidon.test.ts`, `ui/src/components/myrmidon/{featuresApi.ts,FeaturesView.tsx,FeaturesView.myrmidon.test.tsx}`, `ui/src/pages/InstanceFeatures.tsx`, `docs/myrmidon/guides/features-page{,.ru}.md`. Наши файлы с точечными правками (отчёт прохода в реестр): `server/src/myrmidon/bot-containers/{draft-lifecycle,bot-disk-service,startup}.ts`, `server/src/myrmidon/swarm-claim/sweep.ts`, `server/src/myrmidon/litellm-costs/{startup,litellm-costs}.ts`, `server/src/myrmidon/litellm-fallback-signal/sweep.ts`, `server/src/myrmidon/agent-memory/service.ts`. Файлы вендора: `server/src/app.ts` (импорт и монтирование роутов, 2 строки), `server/src/index.ts` (запуск и остановка прохода здоровья, 3 строки), `server/src/services/attention.ts` (импорт, идентификатор субъекта и блок карточки), `ui/src/App.tsx` (импорт и маршрут), `ui/src/components/CompanySettingsSidebar.tsx` и `.production.tsx` (пункт «Features»), `ui/src/components/access/CompanySettingsNav.tsx` (вкладка), `ui/src/lib/instance-settings.ts` (суффикс `/features`), правки тестов вкладок и пути (по строке), `packages/shared/src/index.ts` (экспорт), `ui/src/i18n/myrmidon-locales/{en,ru}.json` (блок `features`, `settingsNav.features`) | Требование владельца 04.10: у каждой возможности форка есть настройка и пункт в интерфейсе, и оператор видит, работает ли она. Возможности молча не работали: самозахват роя ничего не захватывал, обход диска ботов падал с `ENOENT` на каждом проходе, интерфейс памяти был выключен, общему кэшу пакетов не хватало обновления фильтра сокета, и этого никто не видел | `server/src/myrmidon/features/features.myrmidon.test.ts` (рекордер; каждая определённая возможность: выключена / неверно настроена / сбой / работает / неизвестно на фактах; отчёт обхода диска ботов на реальном каталоге; часы сигнала в 30 минут; полнота реестра), `server/src/myrmidon/features/routes.myrmidon.test.ts` (права, переключатель, 404 и неверное тело), `ui/src/components/myrmidon/FeaturesView.myrmidon.test.tsx` (порядок по здоровью, `unknown` не рисуется как `working`, ошибка и эффект, переключатель и его блокировка, ссылки) | Никогда, наше поведение. Новая возможность форка добавляется в реестр одним определением; снять — удалить `server/src/myrmidon/features/`, блок и маршрут UI, вызовы в `app.ts`, `index.ts`, `attention.ts` и отчёты прохода в модулях | (этот PR) |

## settings-en-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->

### 1.6.2 — FEATURES: Instance → Features page (feature registry with live health)

The page `Instance → Features` (`/company/settings/instance/features`) lists the fork features with their
effective configuration and live health; the API is `GET /api/myrmidon/features` (any board member; `?fresh=1`
bypasses the 20-second cache) and `PATCH /api/myrmidon/features/:key` with `{ "enabled": true|false }` (instance
admin only; only features with an inline switch: the swarm self-claim and the bot disk lifecycle, through
the same services as their own settings). It adds one environment variable and no stored setting. Full
guide: [guides/features-page.md](guides/features-page.md).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC` | 1.6.2-FEATURES | `300` | Period in seconds of the health pass over the whole feature registry. The pass feeds the attention signal: a feature that is enabled and `misconfigured` or `failing` for more than 30 minutes raises one card in the attention queue (the 30 minutes are counted by the server process and restart with it). The first pass runs one minute after start. The report is read from the cache for 20 seconds, so a page load does not stack queries | From 60 to 3600; non-integer or out of bounds — `300` is taken. There is no switch: the pass only reads, and the feature rows stay `unknown` where a module has no health signal |

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->

### 1.6.2 — FEATURES: страница Instance → Features (реестр возможностей с живым здоровьем)

Страница `Instance → Features` (`/company/settings/instance/features`) перечисляет возможности форка с
действующей настройкой и живым здоровьем; API — `GET /api/myrmidon/features` (любой участник доски;
`?fresh=1` обходит кэш в 20 секунд) и `PATCH /api/myrmidon/features/:key` с телом `{ "enabled": true|false }`
(только администратор экземпляра; только возможности со встроенным переключателем: самозахват роя и
жизненный цикл диска ботов, через те же сервисы, что и их собственные настройки). Добавляет одну
переменную окружения и ни одной сохраняемой настройки. Полное руководство:
[guides/features-page.ru.md](guides/features-page.ru.md).

| Переменная | Функция | Умолчание | Что делает | Как отключить / особые случаи |
|---|---|---|---|---|
| `MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC` | 1.6.2-FEATURES | `300` | Период в секундах прохода здоровья по всему реестру возможностей. Проход питает сигнал во внимание: возможность, которая включена и `misconfigured` или `failing` дольше 30 минут, поднимает одну карточку в очередь внимания (30 минут считает процесс сервера, и они начинаются заново после его перезапуска). Первый проход идёт через минуту после старта. Отчёт читается из кэша 20 секунд, поэтому открытие страницы не плодит запросы | От 60 до 3600; нецелое или вне границ — берётся `300`. Выключателя нет: проход только читает, а строки возможностей остаются `unknown`, где у модуля нет сигнала здоровья |
