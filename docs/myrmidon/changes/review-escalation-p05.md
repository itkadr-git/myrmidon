---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Review escalation after the round limit goes to technical reviewers, never to the issue owner (OPE-8327)

- When a review stage exhausts its rounds, `reviewEscalationPolicy` (roles `lead` → `architect` → `secondary_reviewer`, `policyRevision`, `fallbackQueue`) picks the next technical agent; candidates outside the issue project or caste, or equal to the issue owner/creator, are skipped. The escalated reviewer holds the stage across unrelated updates until they decide.
- The transition is persisted (`reviewCycleId`, `escalationPolicyRevision`, `escalationReason=review_round_limit`, from/to participants). If no technical reviewer exists, the issue stays in review and one recovery interaction is raised, deduplicated by `(issue, reviewCycleId, policyRevision)`.
- Progression is by round: an escalated reviewer gets a fresh round budget and, on exhausting it, the stage moves to the next role; the exhausted actor is never reselected.
- Metric `review_escalation_to_user_owner` is emitted whenever an escalation reaches the human owner: the legacy policy-less hand-off and the recovery card (addressed to the owner). With technical reviewers available the value is 0.

## changelog-ru

### Эскалация ревью после лимита раундов идёт к техническим ревьюерам, а не к владельцу задачи (OPE-8327)

- Когда ревью исчерпало раунды, `reviewEscalationPolicy` (роли `lead` → `architect` → `secondary_reviewer`, `policyRevision`, `fallbackQueue`) выбирает следующего технического агента; кандидаты вне проекта или касты задачи, а также владелец/создатель задачи пропускаются. Эскалированный ревьюер удерживает стадию при посторонних обновлениях, пока не примет решение.
- Переход сохраняется (`reviewCycleId`, `escalationPolicyRevision`, `escalationReason=review_round_limit`, от/к участнику). Если технического ревьюера нет, задача остаётся в ревью и создаётся одна recovery-интеракция с дедупликацией по `(задача, reviewCycleId, policyRevision)`.
- Прогрессия по раундам: эскалированный ревьюер получает новый бюджет раундов и, исчерпав его, передаёт стадию следующей роли; исчерпавший актор не выбирается повторно.
- Метрика `review_escalation_to_user_owner` отправляется при любой эскалации к владельцу: прежняя передача без политики и recovery-карточка (адресована владельцу). Пока есть технические ревьюеры, значение 0.

## divergence

| 1.6.6-REVIEW-ESC | Эскалация ревью после лимита раундов: `reviewEscalationPolicy`, резолвер участников lead → architect → secondary, запрет владельца на стадии, идемпотентность по (issueId, reviewCycleId, policyRevision) | `server/src/services/issue-execution-policy.ts`, `server/src/routes/issues.ts`, `packages/shared/src/types/issue.ts`, `packages/shared/src/validators/issue.ts` | Эскалация ревью не должна возвращаться пользователю-владельцу (дизайн OPE-8312, §4.B.1) | `server/src/__tests__/issue-execution-policy.test.ts` (review round circuit breaker) | Никогда, наше поведение | (этот PR) |
