## changelog-en

### Fix: the board failed to start when a synthetic attention card was present

- The attention list looks up agent names with `agents.id IN (...)`. The
  bot-disk lifecycle card uses a key (`bot-disk-lifecycle`) as its subject id,
  not an agent id, and that key went into the lookup; Postgres rejected the
  uuid cast and the board exited at start. Agent-name lookups now take only
  uuid-shaped ids (`isAgentIdLike`), and the clone-hygiene lookup skips the
  query when no bot key is a uuid.

## changelog-ru

### Исправление: доска не запускалась при синтетической карточке внимания

- Список внимания подставляет имена агентов запросом `agents.id IN (...)`.
  Карточка жизненного цикла диска ботов использует в качестве id объекта ключ
  (`bot-disk-lifecycle`), а не id агента, и этот ключ попадал в запрос: Postgres
  отклонял приведение к uuid, и доска завершалась при старте. Теперь в поиск
  имён попадают только id вида uuid (`isAgentIdLike`), а поиск для отчёта о
  клонах не выполняется, если среди ключей нет uuid.
