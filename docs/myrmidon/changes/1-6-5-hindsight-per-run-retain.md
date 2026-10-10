---
divergence-section: 1.2 — плагины
settings-section: Settings in the agent record (not environment variables)
---

## changelog-en
### Memory is written once per run; run-start recall is conditional (1.6.5 PERF-DIET HS/D1)

- The hindsight memory fork (`0.3.0-myrmidon.2`) no longer writes one memory
  per ticket comment: a run's comments wait in run-scoped plugin state and
  are retained as one `Run <runId> digest` per bank at run end (metadata
  carries `kind: "run-digest"`, run/agent/issue ids, comment count; duplicate
  ids collapse, short bodies and board-machinery comments drop). A comment
  outside a run is retained immediately, as before. A failed retention is a
  warning; the run never fails because of memory.
- Run-start recall takes the plugin config field `recallOnRunStart`:
  `new-issue` (default — search only when the agent has not already searched
  this ticket), `always` (old behaviour) or `never`. `hindsight_recall` still
  searches on demand. Bank routing is unchanged.
## changelog-ru

### Память пишется раз за прогон, а поиск на старте прогона стал условным (1.6.5 PERF-DIET HS/D1)

- Форк памяти (`packages/plugins/hindsight-paperclip`, версия
  `0.3.0-myrmidon.2`) больше не пишет по одной записи на каждый комментарий
  задачи. Комментарии прогона ждут в состоянии плагина области прогона и
  уходят одним дайджест-документом на банк, когда прогон заканчивается:
  заголовок документа `Run <runId> digest`, внутри — нумерованный список
  комментариев с автором и задачей, в metadata — `kind: "run-digest"`,
  `runId`, `agentIds`, `issueIds`, `commentCount`. Повторы по `commentId`
  схлопываются, тела короче 200 знаков и служебные комментарии доски
  (заголовок `## …`, смена статуса, notice о пробуждении, вердикт `Review:`)
  отбрасываются, буфер очищается после записи. Комментарий вне прогона —
  человека или события без `runId` — по-прежнему пишется сразу: это новый
  вход для следующего прогона, который возьмёт задачу. Неудачная запись —
  предупреждение в журнале плагина, прогон из-за памяти не падает.
- Поиск памяти на старте прогона стал условным. Новое поле конфигурации
  экземпляра плагина `recallOnRunStart` (не переменная окружения) принимает
  `new-issue` (по умолчанию), `always` или `never`. `new-issue` ищет в банке
  агента только если агент ещё не искал по этой задаче, поэтому повторные
  пробуждения по одной задаче больше не платят за один и тот же локальный
  реранкер; `always` сохраняет прежнее поведение, `never` выключает поиск на
  старте. Инструмент `hindsight_recall` ищет по запросу как раньше.
- Маршрутизация банков не менялась: `adapterConfig.hindsight.bankId` карточки,
  затем `bankByAgentId`, иначе агент закрыт.
## divergence

| PERF-DIET-HS | Форк плагина памяти (`packages/plugins/hindsight-paperclip`, версия `0.3.0-myrmidon.2`) пишет в память раз за прогон вместо записи на каждый комментарий: комментарии агента копятся в состоянии плагина области прогона (`scopeKind=run`, ключ `retain-buffer`), а на `agent.run.finished` уходят одним дайджест-документом на банк — заголовок `Run <runId> digest`, нумерованный список комментариев с автором и задачей, metadata `{kind:"run-digest", runId, agentIds, issueIds, commentCount}`; дубликаты по `commentId` схлопываются, тела короче 200 знаков и служебные комментарии доски (заголовок `## …`, «status changed», notice о пробуждении, вердикт `Review:`) отбрасываются, после записи буфер очищается. Комментарий человека или событие без `runId` по-прежнему пишутся сразу: это новый вход для следующего прогона. Поиск памяти на старте прогона стал условным: новое поле конфигурации экземпляра плагина `recallOnRunStart` (`always` \| `new-issue` \| `never`, по умолчанию `new-issue`) ищет в банке агента только если агент ещё не искал по этой задаче (ключ `hindsight-last-recall-issue` в состоянии агента); `never` выключает поиск на старте. Ошибка записи на финише — предупреждение в журнале плагина, прогон не падает | Вендор не тронут: правка в файлах форка `packages/plugins/hindsight-paperclip/src/plugin.ts`, `src/manifest.ts`, `README.md`; маршрутизация банков (`src/bank.ts`) не менялась и не трогалась | Решение владельца 04.10 (D1, реестр PERF-DIET v2): на бою 1828 записей в банк за час и 227 поисков, очередь консолидации банка растёт, hindsight тратит около 3,3 ядра | `packages/plugins/hindsight-paperclip/src/plugin.test.ts` — блоки «run digest retention» и «conditional run-start recall»; тест «one digest when the run finishes» падает на базовой версии `plugin.ts` (два retain на `issue.comment.created` вместо одного дайджеста) | Поведение форка: вернуть retain на `issue.comment.created` и поиск на каждом `agent.run.started` — убрать буфер, ключ `recallOnRunStart` вернуть к `always` | (этот PR) |

## settings-en-append

<!-- section: Settings in the agent record (not environment variables) -->
| `recallOnRunStart` (plugin instance configuration, not an environment variable) | PERF-DIET-HS | `new-issue` | Run-start recall policy of the hindsight plugin (`packages/plugins/hindsight-paperclip`): `new-issue` — search the agent's bank only when the agent has not already searched for this ticket; `always` — search on every run start (the previous behaviour); `never` — no run-start search. The `hindsight_recall` tool is unaffected. Set in the plugin's instance configuration, not in env; a value absent or outside the enum reads as `new-issue`. What the plugin writes into the bank — [guides/agent-memory-card.md](guides/agent-memory-card.md) | `always` restores the previous behaviour; `never` turns run-start recall off |

## settings-ru-append

<!-- section: Настройки в записи агента (не переменные окружения) -->
| `recallOnRunStart` (конфигурация экземпляра плагина, не переменная окружения) | PERF-DIET-HS | `new-issue` | Политика поиска памяти на старте прогона у плагина hindsight (`packages/plugins/hindsight-paperclip`): `new-issue` — искать в банке агента только если агент ещё не искал по этой задаче; `always` — искать на каждом старте прогона (прежнее поведение); `never` — поиска на старте нет. Инструмент `hindsight_recall` работает как раньше. Задаётся в конфигурации экземпляра плагина, не в окружении; отсутствующее значение или значение вне перечисления читается как `new-issue`. Что плагин пишет в банк — [guides/agent-memory-card.ru.md](guides/agent-memory-card.ru.md) | `always` возвращает прежнее поведение; `never` выключает поиск на старте |
