---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Assessment: heartbeat preflight budget caps are already covered (OPE-8647)

- Evaluated Paperclip PR [#8347](https://github.com/paperclipai/paperclip/pull/8347),
  merged 2026-06-20 as commit `631b7806ed92c43bd6b5666ad8b1406635d1ab18`.
- Upstream adds per-agent daily run and spend caps checked before enqueue and
  again at claim, clean cancellation of capped queued runs with issue-lock release
  and deferred-wake promotion, plus opt-in skipping of timer wakes without work.
- Myrmidon already has those core behaviors: admission cap checks, a claim-time
  cap recheck, safe cancellation, skipped wake metadata, per-agent/global idle
  timer skipping, and additional idle-work checks for pending interactions and
  assigned review participation. No behavior or settings change is recommended.
- Do not cherry-pick or establish automatic synchronization. Use upstream #8347
  as a regression checklist; open a separate implementation issue only if review
  finds a concrete missing execution path.

## changelog-ru

### Оценка: лимиты heartbeat до запуска уже реализованы (OPE-8647)

- Проверен PR Paperclip [#8347](https://github.com/paperclipai/paperclip/pull/8347),
  влитый 20.06.2026 коммитом `631b7806ed92c43bd6b5666ad8b1406635d1ab18`.
- Вендор добавил дневные лимиты запусков и расходов с проверкой перед постановкой
  в очередь и повторной проверкой при захвате запуска, безопасную отмену
  запусков с освобождением lock задачи и продвижением отложенных пробуждений,
  а также необязательный пропуск пустых пробуждений по таймеру.
- Основное поведение уже есть в Myrmidon: проверки лимитов при допуске и захвате,
  безопасная отмена, метаданные пропуска, локальный и глобальный пропуск пустых
  таймеров, дополнительные проверки ожидающих взаимодействий и участия в ревью.
  Новых изменений кода или настроек не рекомендуется.
- Не делать cherry-pick и не настраивать автосинхронизацию. Использовать PR #8347
  как список регрессионных проверок; отдельную задачу реализации заводить только
  если проверка выявит конкретный непокрытый путь запуска.

## divergence

| OPE-8647-HEARTBEAT-PREFLIGHT-CAPS | Evaluated Paperclip PR #8347 / commit 631b780 (daily run and cost cap checks before enqueue and again at claim; queued-run cancellation with issue-lock release/deferred wake promotion) against Myrmidon's existing heartbeat policy. The global/per-agent idle skip, admission and claim-time cap checks, skipped wake metadata, lock release and deferred wake promotion are already implemented; no functional port is recommended. Documentation only | `server/src/services/heartbeat.ts`, `server/src/myrmidon/heartbeat-idle-skip.ts`, `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts` | A blind cherry-pick risks duplicate policy gates and regressions to coalescing, issue locks, deferred wakes, recovery, or proactive timer behavior | Inspect existing admission, claim-time caps, cancellation, lock release and deferred promotion; related regression cases already exist in heartbeat stale-queue tests | No implementation recommended; open a follow-up only if a concrete path lacks coverage | https://github.com/paperclipai/paperclip/pull/8347 |
