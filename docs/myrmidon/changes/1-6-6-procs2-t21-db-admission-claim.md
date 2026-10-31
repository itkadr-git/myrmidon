---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Run admission can be serialized in Postgres (1.6.6 PROCS-2/T2.1)

- With `processes.admissionStore = "db"`, claiming a queued run takes a
  transaction-scoped advisory lock (`myrmidon:run-admission`), counts the
  running rows (global and per agent) and moves the run to `running` in the
  same transaction. Two worker processes can no longer both take the last free
  slot. The global cap is the configured `maxConcurrentRuns` of run admission;
  the per-agent cap is the agent's heartbeat `maxConcurrentRuns`.
- The default `memory` mode is unchanged: no lock, no extra counts. Shadow
  comparison and the remaining PROCS-2 items (attention signals, pairing codes,
  import owner, `secrets_changed`) ship in follow-up changes.

## changelog-ru

### Допуск прогонов можно сериализовать в Postgres (1.6.6 PROCS-2/T2.1)

- При `processes.admissionStore = "db"` захват прогона из очереди берёт
  транзакционную advisory-блокировку (`myrmidon:run-admission`), считает
  выполняющиеся прогоны (общий счёт и по агенту) и переводит прогон в `running`
  в той же транзакции. Два рабочих процесса больше не могут оба занять
  последний свободный слот. Общий предел — настроенный `maxConcurrentRuns`
  допуска прогонов, предел агента — `maxConcurrentRuns` его heartbeat.
- Режим `memory` по умолчанию не меняется: ни блокировки, ни дополнительных
  подсчётов. Теневое сравнение и остальные пункты PROCS-2 (сигналы внимания,
  коды сопряжения, владелец импорта, `secrets_changed`) выйдут отдельными
  изменениями.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.6-PROCS2-T21 | Захват queued->running при `admissionStore=db` идёт под advisory-блокировкой с подсчётом running в одной транзакции | `server/src/services/heartbeat.ts` (ветка claim в `claimQueuedRun`) | Несколько процессов не должны занимать последний слот одновременно | `server/src/__tests__/db-run-admission.myrmidon.test.ts` | Когда вендор вводит собственную общую admission в БД: удалить `server/src/myrmidon/db-run-admission.ts` и ветку в claim | #1489 |
