---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## divergence-replace

<!-- section: Трек 2 — ядро побудок и прогонов -->
| L4 | `escalateStrandedAssignedIssue` для причин `stranded_assigned_issue` / `successful_run_missing_state` с последним прогоном `succeeded`: до `MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY` продолжений в сутки назначенному исполнителю (с явной просьбой выставить причину блокировки) проходят через L4 auto-policy даже при `rerouteToSharedQueue`; неуспешные/отсутствующие прогоны сохраняют прежний vendor path. При исчерпании бюджета/паузе или отсутствии цели эскалации остаётся `vendor_default`. | `server/src/services/recovery/service.ts` (`decideStrandedAutoPolicy` gate) | Раньше `!input.rerouteToSharedQueue` отсеивал успешные stranded-сценарии из sweep-путей, уводя их в vendor default вместо L4 политики | `server/src/__tests__/issue-recovery-actions.test.ts` («L4 stranded auto-policy»: reroute=true + succeeded + successful_run_missing_state → одна L4 continuation wake, in_progress сохранён, vendor recovery action отсутствует) | Удалить добавленный L4 тест и вернуть ограничение reroute в `decideStrandedAutoPolicy` | OPE-9284 |
