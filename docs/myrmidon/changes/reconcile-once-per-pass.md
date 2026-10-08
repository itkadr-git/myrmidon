## changelog-en

### One read per reconcile sweep, not one per bot (PERF-DIET-G)

The bot container reconciler compiles a profile for every bot on every sweep
(once a minute), and most of what it read is company- or instance-scoped: the
skill lifecycle delivery of the company, the runtime skill catalogue and its
files, and the instance settings (compression defaults, helper ceiling,
language-server policy, shared package cache, pnpm store, clone TTL). All of it
was read again for every bot, so a fleet of N bots paid N times a minute.

- A sweep now shares one pass: the first bot of a tick reads those values and
  every other bot of the same tick gets what it read. The pass is dropped at the
  end of the sweep — a settings or skill change still reaches the bots within
  one reconcile interval, exactly as before, and nothing is cached between
  ticks. A skill carried by several bots is also read from disk once per pass.
- `pnpmSettings` was read twice per bot inside one compile (once for the
  package-cache variables, once for the scope instance's store path); it is now
  read once per pass.
- The agent card behind a profile is read as a single row by id instead of the
  board's own `getById`, which also hydrates the whole company and the agent's
  month spend — three queries where the profile needs the columns. Name
  normalization and the cost view are for the agents list, not for a container
  profile.
- The card's "Apply now" and the canary wave reconcile one bot: they pass no
  shared pass and behave as before. The reconciler log, the interfaces and the
  UI are unchanged.

Measured with counting fakes over a sweep of three bots: 21 instance-scoped
port calls before, 6 after (one per reader; six of the "before" are the doubled
pnpm read); the skill catalogue 3 -> 1, the lifecycle's company-wide reads
3 -> 1, a skill directory carried by two bots 2 -> 1, and the card read 3 rows
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