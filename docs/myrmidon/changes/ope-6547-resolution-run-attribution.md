---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Agents can resolve their own interaction cards on automation runs (1.6.6 OPE-6547)

- Accept/reject/respond/verdicts on an issue-thread interaction (`POST
  /api/issues/{id}/interactions/{interactionId}/...`) no longer require the run
  named in `X-Paperclip-Run-Id` to record the same responsible user as the agent
  API key that authenticates the call.
- Automation (heartbeat) runs record the issue's responsible user, a steering
  comment's author, or the company default — a service account — while a key is
  issued to a person, so every key-authenticated resolution was rejected with
  422 `interaction_run_attribution_required` and agent `request_confirmation`
  cards stayed pending forever.
- The gate keeps its real checks (the run exists, belongs to the same company
  and to the authenticated agent); who may resolve is still decided by the
  resolver audience (addressee, creator exclusion, human-only, governed
  actions), as it already was for the withdraw route.

## changelog-ru

### Агент может закрыть свою карточку interaction на автоматизационном прогоне (1.6.6 OPE-6547)

- Принятие, отклонение, ответ и вердикты по карточке issue-thread interaction
  (`POST /api/issues/{id}/interactions/{interactionId}/...`) больше не требуют,
  чтобы у прогона из `X-Paperclip-Run-Id` был тот же responsible user, что у
  агентского API-ключа, которым подписан вызов.
- Автоматизационные (heartbeat) прогоны несут ответственного тикета, автора
  управляющего комментария или сервисную учётную запись компании по умолчанию,
  а ключ выписан на человека: любое разрешение по ключу падало с 422
  `interaction_run_attribution_required`, и карточки `request_confirmation`
  агента висели в pending навсегда.
- Содержательные проверки гейта сохранены (ран существует, та же компания, тот
  же agentId); право резолвить по-прежнему определяет аудитория резолвера
  (адресат, исключение создателя, human_only, управляемые действия) — как это
  уже было на маршруте withdraw.

## divergence

| OPE-6547-RESOLUTION-RUN-ATTRIBUTION | Маршруты разрешения карточки issue-thread interaction (accept / reject / respond / verdicts) вызывают `assertAgentInteractionRunAttribution` с `allowResponsibleUserMismatch: true`: совпадение `run.responsibleUserId` с `actor.onBehalfOfUserId` (владельцем агентского ключа) больше не требуется. Остальные проверки атрибуции неизменны — ран существует в `heartbeatRuns`, та же компания, тот же `agentId`, актор в доверенной области тикета; право резолвить по-прежнему решает `evaluateIssueThreadInteractionResolverAudience` (адресат, `not_creator`, `human_only`, управляемые действия) | Вендор: `server/src/routes/issues.ts` (метка `myrmidon(OPE-6547)` в `getIssueThreadInteractionResolutionAuthorization` и в комментарии опции `allowResponsibleUserMismatch`), тест-сторож в вендорском `server/src/__tests__/issue-thread-interaction-routes.test.ts` | Автоматизационные прогоны несут `responsibleUserId` сервисной учётной записи (ответственный тикета / автор управляющего комментария / умолчание компании), а ключи агентов выписаны на человека, поэтому агент с валидным ключом и валидным run-id не мог принять или отклонить собственную карточку `request_confirmation`: 422 `interaction_run_attribution_required`, pending-карточки висели (найдено на OPE-6410). Строгий дефолт, оставленный в OPE-6241, был несовместим с ключевой аутентификацией: владелец ключа никогда не является responsible user прогона | `server/src/__tests__/issue-thread-interaction-routes.test.ts` («allows the assignee agent to accept from an automation run with a service responsible user», «allows the assignee agent to reject …», а также тесты withdraw из OPE-6241 и отказы посторонним акторам) | Когда вендор сам перестанет связывать responsible user прогона с владельцем ключа на маршрутах разрешения: убрать `allowResponsibleUserMismatch: true` в `getIssueThreadInteractionResolutionAuthorization` (метка `myrmidon(OPE-6547)`) и вернуть строгий вызов | (этот PR) |