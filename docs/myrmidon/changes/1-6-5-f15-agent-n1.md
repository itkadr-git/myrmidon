## changelog-en

### Attention feed: one query for per-agent prompt-budget runs (1.6.5 F-15 D)

- The Attention feed reads each agent's last run with a measured prompt size
  for the prompt-budget cards. The old code sent one `heartbeat_runs` query
  per agent. On the audited board that was about 84 round trips in a cold
  feed build.
- The feed now fetches all agents in one statement: one lateral top-20 scan
  per agent, joined through a single round trip. The selection rules — scan
  window, ordering, the fallback from `finished_at` to `started_at`, and the
  "first row with a usable prompt size" pick — did not change. Feed
  composition stays identical.
- Tests: an embedded-Postgres equivalence test seeds 5 agents × 10 runs and
  compares the batched read against the old per-agent loop, row for row; the
  perf test seeds 1 000 runs across 80 agents and fails if the read stops
  being a single statement (100 ms budget) or, when
  `MYRMIDON_PROMPT_BUDGET_PERF=1` is set, exceeds 300 ms on embedded
  Postgres.

## changelog-ru

### Attention-фид: один запрос на прогоны prompt-budget по всем агентам (1.6.5 F-15 D)

- Attention-фид читает последний прогон каждого агента с измеренным размером
  промпта для карточек prompt-budget. Прежний код слал по запросу
  `heartbeat_runs` на каждого агента: на проверенной доске это около 84
  обращений к базе на холодную сборку фида.
- Теперь фид получает данные всех агентов одним запросом: боковой (lateral)
  скан top-20 на агента в один round trip. Правила отбора — окно скана,
  сортировка, запасной путь `finished_at` → `started_at` и выбор «первой
  строки с измеренным размером промпта» — не меняются. Состав фида тот же.
- Тесты: тест на встроенном Postgres сеет 5 агентов × 10 прогонов и
  сравнивает пакетное чтение с прежним циклом по агентам строка в строку;
  perf-тест сеет 1 000 прогонов на 80 агентов и падает, если чтение
  перестаёт быть одним запросом (бюджет 100 мс) или — при
  `MYRMIDON_PROMPT_BUDGET_PERF=1` — превышает 300 мс на встроенном Postgres.
