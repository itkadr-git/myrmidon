# OPE-12886 REVIEWER-WAKE — рабочие заметки разбора (13.11, прогон c3e1d2d8)

## Установленные факты (по боевой доске, API-чтение)

- Ревьюеры сейчас (12.11 17:38Z): 5 из 6 idle (review-8/10/11/12/13), review-9 running.
  Значит дефект «все 6 idle при 20 задачах in_review» воспроизводим/воспроизводился.
- Пагинация `GET /api/companies/:id/heartbeat-runs` — курсорная: `limit=300` возвращает
  только последние 300 строк и заголовок `X-Next-Cursor` (createdAt последней строки).
  Читал окно `startedAfter/startedBefore` — фактически эти параметры роут игнорирует;
  фильтр делается по `before`-курсору (лимит 1000).
- Прогоны ревьюеров 13.11 14:37–17:35Z (окно UTC, доска локально = UTC+3 → дефект 00:20
  локального 13.11 соответствует ~21:20Z 12.11 — этот час ещё не дочитан из-за пагинации).
- Виден долгий простой review-8: max gap 73 мин (15:10 → 16:23) при задачах in_review.
  У остальных gaps 17–32 мин. Это уже нарушает НАМЕРЕНИЕ «не позже 5 минут».
- Часть побудок в очереди висит как `queued` с `startedAt=null` (видно в списке runs).

## Карта кода (server/src)

- `myrmidon/idle-pickup.ts` — подбор по простою: `_internal` (строка ~1060) содержит
  функции подбора; 69 упоминаний agentWakeupRequests.
- `myrmidon/deferred-wake-revisit.ts` — ревизит отложенных побудок (cool-down,
  «promotes», «expires deferred wakes older than thirty minutes»).
- `services/heartbeat.ts`:
  - `insertReviewAdmissionWakeup` (~24671): вставка review-admission побудки,
    dedup по `idempotencyKey`, статус `queued`.
  - `dispatchClaimedIssueMonitor` (~12343), `tickDueIssueMonitors` (~13132).
  - `releaseIssueExecutionAndPromote` (~31785) — освобождение замка задачи и
    промоция отложенных побудок; в wake-queue адаптере 21 упоминание.
  - tick: перед dispatch мониторов чистит квоты `clearReviewWakesQuotas(now)`
    (~37196–37206), чтобы отложенная по квоте побудка попала в свежий бюджет тика.
- `modules/wake-queue/adapters/postgres.ts` — 85 упоминаний deferred_issue_execution;
  `set local lock_timeout='5s'` при release-drain (~1155).
- `modules/wake-queue/application/use-cases.ts` — runReleaseDrain/promote (~177, 397, 1093).
- `myrmidon/review-stage-recovery/review-wakes-quota.ts` — квота #2758:
  `REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK`, admit-функция.
- `myrmidon/review-stage-recovery/policy.ts` — admission gate `decideReviewAdmission`:
  некритичные задачи ждут зелёного `CI result` на точную голову (`wait_for_ci`,
  `wait_red`); dedup ключ `issue-review-admission:{issueId}:{headSha}` (OPE-12177);
  `reviewVerdictCoversHead` (OPE-12859) — вердикт на текущую голову гасит ре-вейк.
- `routes/agents.ts` `buildSkippedWakeupResponse` (~2150): skipped-ответ с
  `reason: issue_execution_deferred`, когда у задачи есть живой execution run.
- Тест-образец для embedded-postgres: `__tests__/stranded-deferred-wake-reconcile.myrmidon.test.ts`
  (440 строк, паттерн seed companies/agents/issues + heartbeatService(db)).

## Гипотезы причины простоя 13.11 (проверить в следующем прогоне)

1. review-admission dedup: ключ `issue-review-admission:{issueId}:{headSha}` + условие
   `status <> 'skipped'` — «deferred» строка блокирует новые побудки той же задачи,
   а ревизит отложенной (deferred-wake-revisit) срабатывает только через cool-down
   (10–30 мин) — это и есть «skipped из-за deferred_issue_execution» из дефекта.
2. admission gate: некритичные задачи с CI=waiting (`pending|unknown`) не будят
   ревьюера вовсе — `REVIEW_CI_WAIT_*` монитор должен их вернуть, но если PR-ворк-
   продукт не читается (`unknown` без монитора) → вечное ожидание без побудки.
3. Квота #2758: после исчерпания `REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK` побудки
   откладываются до следующего тика; чистка buckets происходит перед dispatch
   мониторов — проверить, что idle-pickup и admission реально попадают в следующий
   тик (порядок вызовов в tickTimers ~37090).
4. Долгий gap review-8 (73 мин) указывает, что самый старый in_review не получает
   побудку: возможно idle_pickup берёт задачу не самую старую или скипает по
   eventRevision/по вердикту на голову.

## Следующий шаг

- Дочитать окно ~19:30–21:45Z 12.11 (час дефекта) через `before`-курсор, собрать
  wake-статусы по задачам in_review; затем исправление в `idle-pickup._internal` /
  review-admission + тест в `stranded-deferred-wake-reconcile`-стиле.
