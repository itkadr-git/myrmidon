---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Swarm matcher reads real executor load, capacity, pause and quota

- The matcher now counts the open tasks an executor carries: assigned `todo` (reserved) and
  `in_progress` tasks plus live leases, a task once. Before, only live leases and the idle flag
  counted, so an executor with seven open tasks looked free.
- The ceiling (`maxActiveTasks`, caste override first) applies to that load. A full executor takes
  nothing and the task stays in the queue. Among eligible executors the least loaded one is
  preferred; a full tie still goes to the smallest id.
- The capacity check is atomic: it runs inside the claim transaction under a per-executor advisory
  lock, so two concurrent passes cannot push an executor over the ceiling.
- Paused executors (`status = paused` or `paused_at` set) are skipped until resumed. Executors held by
  a recorded provider quota failure (`error_code = provider_quota`, the "Individual quota" text on a
  run or a wake request, or `providerQuotaRetryNotBefore`) are skipped until the recorded reset, or
  for one hour when none was recorded; a succeeded run after the failure lifts the hold. Other
  transient failures never hold an executor. A fresh heartbeat does not re-admit either case.

## changelog-ru

### Матчер роя читает реальную нагрузку, ёмкость, паузу и квоту исполнителя

- Матчер теперь считает открытые задачи исполнителя: назначенные `todo` (резерв) и `in_progress`
  плюс живые аренды, каждая задача один раз. Раньше считались только живые аренды и флаг простоя,
  поэтому исполнитель с семью открытыми задачами выглядел свободным.
- Потолок (`maxActiveTasks`, сначала переопределение касты) применяется к этой нагрузке. Полный
  исполнитель ничего не берёт, задача остаётся в очереди. Из допущенных предпочитается менее
  загруженный; при полном равенстве по-прежнему меньший id.
- Проверка ёмкости атомарна: она идёт внутри транзакции захвата под advisory-замком исполнителя,
  поэтому два одновременных прохода не превысят потолок.
- Исполнители на паузе (`status = paused` или задан `paused_at`) пропускаются до возобновления.
  Исполнители с записанным отказом по квоте провайдера (`error_code = provider_quota`, текст
  «Individual quota» в запуске или в запросе пробуждения, `providerQuotaRetryNotBefore`)
  пропускаются до записанного сброса, а если сброс не записан - на один час; успешный запуск после
  отказа снимает удержание. Прочие временные сбои исполнителя не блокируют. Свежий heartbeat не
  возвращает ни паузу, ни квоту.
