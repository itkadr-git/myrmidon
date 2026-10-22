---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Complete busy-agent profile updates (L6-PROFILE-UPDATE-STARVATION)

- Maintenance drain completion waits for owned interrupted runs to finish teardown before promoting retries.
- The stuck-window backstop applies only to agent-scoped `entering` windows and closes them through the normal exit path (queue wake, exit hook).
- Agent status exposes pending profile-update time while an agent-scoped maintenance window is open.

## changelog-ru

### Завершение обновления профиля занятого агента (L6-PROFILE-UPDATE-STARVATION)

- Слив обслуживания ждёт завершения teardown прерванных прогонов перед продвижением повторов.
- Страховка от зависших окон действует только на окна области agent в состоянии `entering` и закрывает их обычным путём выхода (побудка очереди, хук выхода).
- Статус агента показывает время ожидания обновления профиля при открытом окне обслуживания агента.

## divergence

| L6-PROFILE-UPDATE-STARVATION | Maintenance drain completion and profile pending visibility | `server/src/myrmidon/maintenance/{domain,service}.ts`, `server/src/myrmidon/bot-containers/routes.ts` | Busy agents could keep profile updates pending because interrupted retries were not promoted after teardown. | `server/src/myrmidon/maintenance/drain-complete.myrmidon.test.ts` | Remove the marked maintenance drain and status changes when the vendor provides equivalent behavior. | This PR |
