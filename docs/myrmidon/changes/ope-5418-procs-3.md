---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Live API process scaling and split deploy (PROCS-3)

- The process supervisor applies `apiCount` changes without a container restart.
  It scales the API children up and down through the readiness gate and drains
  children before removing them from service.
- A split deployment keeps the worker alive while API children start, and
  returns to the worker listener when the child set cannot stay available.
- The supervisor keeps the child IPC lifecycle and hot-restart handoff in one
  place, so a child restart does not create a second scheduler or lose the
  worker's control of the deployment.

## changelog-ru

### Живое масштабирование API-процессов и выкат split (PROCS-3)

- Супервизор применяет изменение `apiCount` без перезапуска контейнера.
  Процессы API добавляются и убираются через гейт готовности, а перед удалением
  проходят drain.
- При выкате split worker продолжает работать, пока процессы API запускаются.
  Если набор детей не может остаться доступным, трафик возвращается на listener
  worker.
- IPC-жизненный цикл и передача при hot-restart остаются в одном супервизоре.
  Перезапуск ребёнка не создаёт второго планировщика и не теряет контроль worker.

## divergence

| PROCS-3 | Живое изменение числа API-процессов и переход в split через супервизор: readiness quorum перед отдачей трафика, drain при уменьшении `apiCount`, backoff и аварийный возврат к listener worker при потере детей | `server/src/index.ts`, `server/src/myrmidon/processes/{supervisor,child,service}.ts`, `server/src/services/process-role.ts` | Настройка из интерфейса должна менять HTTP-мощность без перезапуска и не останавливать фонового исполнителя | `server/src/myrmidon/processes/supervisor.myrmidon.test.ts`; `server/src/__tests__/procs/drain-failover.test.ts` | Когда вендор добавит эквивалентный live process supervisor with readiness and drain | (this PR) |

## settings-en

| `PAPERCLIP_PROCESS_ROLE` | PROCS-3 | `all` | Worker and API children use the role gate; API children only serve HTTP and worker owns background work | Unset uses the single-process `all` role |

## settings-ru

| `PAPERCLIP_PROCESS_ROLE` | PROCS-3 | `all` | Роли worker и API проходят через единый гейт: API отдаёт HTTP, worker владеет фоновой работой | Не задавать: действует однопроцессная роль `all` |
