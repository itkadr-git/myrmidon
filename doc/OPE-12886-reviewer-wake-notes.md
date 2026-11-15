# OPE-12886 — Анализ первопричины простоя ревьюеров 13.11 (00:00–00:20 UTC)

Дата анализа: 2026-11-12. Исполнитель: adm-dev-eng-16. Только чтение боевых данных + код.

## Факты из боевых данных

- Все шесть ревьюеров (adm-dev-review-8…13) простаивали без прогонов при 20 задачах in_review
  (по 4–7 на каждого), статус агента idle, 0 running/queued.
- На боевой платформе review-routing настройка `queueThreshold` = 8 (проверено через
  `GET /api/myrmidon/companies/{companyId}/review-routing/settings`).
- Побудки при переходе задачи в in_review работают (review-stage / review-admission): run'ы
  ревьюеров за окно — review-9=21, review-10=18, review-13=16, review-11=14, review-8=11,
  review-12=10 — все прогоны были привязаны к конкретным задачам (в т.ч. ручные побудки ADM).
- Квота OPE-12178 (`REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK = 1`) НЕ является причиной:
  она ограничивает только НОВЫЕ побудки при передаче задачи на ревью в момент перехода, а не
  восстановительную liveness-побудку sweep. Не тронута (решение по границе объёма).

## Причина (код)

`sweep.ts`, liveness-ветка (восстановительная побудка застоявшихся ревью): фильтр

```ts
const reviewerLoad = initialLoads.get(review.reviewerAgentId ?? 0;
if (reviewerLoad > 0 && reviewerLoad <= settings.queueThreshold) comment
```

`loadByAgent` возвращает «число задач in_review в статусе pending + число queued/running
run'ов» на агента (`store.ts:505`). Отсюда два эффекта:

1. Ревьюер, ожидающий свою очередь на ревью, ВСЕГДА имеет load >= 1 (минимум его собственная
   задача in_review). Условие `load > 0 && load <= 8` отсекало ВСЕХ ревьюеров с очередью
   1..8 — то есть всех шестерых при очередях 4–7. Это и есть причина простоя.
2. `REVIEW_ROUTING_MAX_WAKES_PER_PASS = 1` — даже при load > threshold за один проход
   (60 сек) будился максимум один ревьюер на всю компанию, остальные ждали часы.

Тесты этого не поймали, потому что фикстура тестов по умолчанию ставит `load = 0`
(`loadByAgent` заглушка возвращает пустую Map) — на тестах ревьюер с задачей всегда выглядел
«idle с пустой очередью», на бою таких ревьюеров не бывает.

## Что изменено (fix)

- `sweep-constants.ts` + (зеркально) `review-stage-recovery/policy-constants.ts`:
  - `REVIEW_WAKE_STALE_AFTER_MS`: 30 мин → 4 мин (побудка за 4–5 минут после застоя,
    интервал прохода 60 сек — граница приёмки «не позже чем через 5 минут» выполняется).
  - `REVIEW_ROUTING_MAX_WAKES_PESSIMISTIC_PER_PASS`... `REVIEW_ROUTING_MAX_WAKES_PER_PASS`: 1 → 6
    (по одному на каждого из шести штатных ревьюеров за один 60-сек проход).
- `sweep.ts`, liveness-ветка: удалён gate по load/queueThreshold; вместо него в начало
  итерации перенесена проверка `countActiveRunsForAgent > 0 → skip` (раньше она была
  внутри, после wake-state проверок). Liveness-контракт: простаивающий ревьюер (0 активных
  run'ов) получает побудку на самую старую застоявшуюся задачу независимо от размера очереди.
- Остальные механизмы не тронуты: retry/backoff (10 мин → 60 мин exp, max 6 попыток,
  escalation OPE-11947), pendingWake/activeRun guard, per-reviewer budget, квота OPE-12178.

## Результат от смены порогов (post-fix behavior)

- Ревьюер с очередью 4–7 задач и 0 run'ов: побудка на самую старую задачу через 4–5 минут
  застоя (было: НИКОГДА при очереди <= 8).
- Ревьюер с очередью > 8: побудка теперь в тот же проход (было: один ревьюер за 60 сек).
- Ревьюер с активным прогоном: не будится (без изменений).
- Двойной побудки нет: activeRun/pendingWake guard, per-reviewer budget и persist-before-dispatch
  с backoff (OPE-11947) сохранены.

## Тесты

`sweep.myrmidon.test.ts` обновлён под новую семантику; старые проверки остались
семантически теми же (что будится, что нет), изменены пороги/условия:
- «wakes one stale pending review per reviewer...» — строки задач теперь stale (10 мин) —
  раньше проходили ложно из-за skip-гейта (load=0), теперь реально проверяют liveness-побудку.
- «measures the stale threshold from last update...» — граница 3 мин не будит, 5 мин будит
  (новая граница приёмки OPE-12886).
- «recovers stale reviews regardless of assignment load...» — теперь покрывает инцидент:
  load=5 (< threshold), 0 активных run'ов, задача stale → побудка; activeRun=true → skip;
  pendingWake=true → skip.
- «reserves the one-dispatch budget...» → «reserves the per-pass wake budget...» — один
  проход будит максимум `MAX_WAKES_PER_PASS` (теперь 6) ревьюеров компании за проход;
  отклонённая диспетчеризация всё равно расходует бюджет ревьюера.
- Обновлены stale-строки в retry/exhausted-тестах (константа больше не 30 мин), deep backoff
  и escalation-тесты не изменены (work off lastWakeAt/lastCancelledRunAt, не от updatedAt).

## Как проверить на бою (после выката, ADM)

```sql
-- Застой (минуты) задач in_review без активного run'а у ревьюера (сейчас):
SELECT i.identifier, a.name AS reviewer,
       round(extract(epoch from (now() - i.updated_at))/60) AS stale_min,
       (SELECT count(*) FROM heartbeat_runs r WHERE r.agent_id = a.id AND r.status IN ('queued','running')) AS active_runs
FROM issues i
JOIN agents a ON a.id = coalesce(i.execution_state->'currentParticipant'->>'agentId', i.assignee_agent_id::text)
WHERE i.company_id = '<company>' AND i.status = 'in_review' AND i.hidden_at IS NULL
ORDER BY stale_min DESC LIMIT 20;
```

Ожидание после выката: у простаивающего ревьюера побудка создаётся в течение 4–5 минут
застоя, `agent_wakeup_requests` получает строку с reason `execution_review_requested`
(mutation `myrmidon_review_wakeup_retry`), максимум 6 ревьюеров за один проход.
