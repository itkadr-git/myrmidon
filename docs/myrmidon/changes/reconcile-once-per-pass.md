## changelog-en

### One read per reconcile sweep, not one per bot (PERF-DIET-G)

The bot container reconciler compiles a profile for every bot on every sweep
(once a minute), and most of what it read is company- or instance-scoped: the
company's skill lifecycle delivery, the runtime skill catalogue and files, and
the instance settings (compression defaults, helper ceiling, language-server
policy, shared package cache, pnpm store, clone TTL). A fleet of N bots paid N
reads a minute.

- A sweep now shares one pass: the first bot of a tick reads those values, the
  others get the same. The pass is dropped at the end of the sweep, so a settings
  or skill change still reaches the bots within one reconcile interval and
  nothing is cached between ticks. A skill carried by several bots is read from
  disk once per pass.
- `pnpmSettings` was read twice per bot per compile; now once per pass.
- The agent card behind a profile is read as one row by id instead of `getById`,
  which also hydrates the company and the agent's month spend.
- "Apply now" and the canary wave reconcile one bot with no shared pass and
  behave as before. Reconciler log, interfaces and UI are unchanged.

Measured over a sweep of three bots with counting fakes: 21 instance-scoped port
calls before, 6 after; skill catalogue 3 -> 1, lifecycle company-wide reads
3 -> 1, a skill directory carried by two bots 2 -> 1, the card read 3 rows
instead of 3 x 3 queries.

## changelog-ru

### Одно чтение на проход реконсайлера вместо чтения на бота (PERF-DIET-G)

Реконсайлер бот-контейнеров собирает профиль каждого бота на каждом проходе
(раз в минуту), и почти всё, что он читает, относится к компании или инстансу:
доставка навыков по жизненному циклу компании, каталог runtime-навыков и его
файлы, настройки инстанса (умолчания сжатия, потолок помощников, политика
языковых серверов, общий кэш пакетов, хранилище pnpm, TTL клонов). Всё это
перечитывалось на каждого бота, то есть флот из N ботов платил N раз в минуту.

- Проход теперь общий: первый бот тика читает эти значения, остальные боты того
  же тика получают прочитанное. Проход сбрасывается в конце обхода — изменение
  настроек или навыка по-прежнему подхватывается не позже следующего прохода,
  между тиками ничего не кэшируется. Навык, который несут несколько ботов,
  также читается с диска один раз на проход.
- `pnpmSettings` читался дважды на бота внутри одной сборки (для переменных
  общего кэша и для хранилища scope-инстанса); теперь — один раз на проход.
- Карточка агента читается одной строкой по id вместо собственного `getById`
  доски, который дополнительно поднимает всю компанию и месячные траты агента —
  три запроса там, где профилю нужны колонки. Нормализация имён и вид трат
  нужны списку агентов, а не профилю контейнера.
- Кнопка «Apply now» и волна канареи реконсайлят одного бота: они не передают
  общий проход и работают как раньше. Лог реконсайлера, интерфейсы и UI не
  меняются.

Замер по счётчикам fake-портов на обходе из трёх ботов: 21 вызов
instance-портов до, 6 после (по одному на порт; шесть из «до» — удвоенное
чтение pnpm); каталог навыков 3 -> 1, общекомпанийные чтения жизненного цикла
3 -> 1, каталог навыка, который несут два бота, 2 -> 1, а карточка — 3 строки
вместо 3 x 3 запросов.