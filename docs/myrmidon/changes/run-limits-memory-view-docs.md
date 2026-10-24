## changelog-en

### Run-limits guide: the load view with the memory snapshot (1.6.5 C0-ui docs)

- [guides/run-limits.md](../guides/run-limits.md) gained a "The load view"
  section: the `memory` block of `GET /api/myrmidon/runtime-limits` (the
  host's available/total memory and the server container's cgroup v2 usage,
  each side `null` when unreadable), next to the queue and host-load
  snapshots, and the line both run settings panels show for it.

## changelog-ru

### Гайд по лимитам прогонов: вид нагрузки со снимком памяти (доки 1.6.5 C0-ui)

- В [guides/run-limits.ru.md](../guides/run-limits.ru.md) добавлен раздел
  «Вид нагрузки»: блок `memory` ответа `GET /api/myrmidon/runtime-limits`
  (свободная/полная память хоста и использование cgroup v2 контейнера
  сервера, каждая сторона `null`, когда не читается) рядом со снимками
  очереди и загрузки хоста, и строка, которую показывают обе панели настроек
  прогонов.
