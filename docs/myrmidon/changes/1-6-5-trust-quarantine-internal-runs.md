## changelog-en

### Internal delegation no longer quarantines lead tasks, without weakening the trust check

- A task written from another agent's same-company run used to be sent to
  `low_trust_review/quarantined`, so its executor got no GitHub token. The
  quarantine is now lifted for that case only when both hold: the actor's run
  id is authenticated (the signed agent JWT `run_id` claim — the
  `X-Paperclip-Run-Id` header sent with an agent API key is client-supplied and
  never lifts a quarantine) and the run's provenance is on an explicit
  allowlist of internal sources (`assignment`/`automation`/`timer` invocations
  with scheduler-style wake sources). Answers to external-chat questions
  (`issue.interaction.respond`), comment wakes, chat/webhook markers and any
  unlisted source stay quarantined.
- Quarantined tasks are refused GitHub credentials with a structured reason and
  the release path (`POST /api/issues/:id/low-trust/promotions`).
- Migration `0387_low_trust_internal_release_candidates` is a dry run: it writes
  `issue.low_trust_release_candidate` audit rows (issue ids) for quarantined
  tasks with provably internal origin and changes no issue. An operator reviews
  the list and releases confirmed tasks through the promotion endpoint.

## changelog-ru

### Внутреннее делегирование больше не отправляет задачи лидов в карантин, проверка доверия не ослаблена

- Задача, записанная из прогона другого агента той же компании, попадала в
  `low_trust_review/quarantined`, и исполнитель не получал токен GitHub.
  Теперь карантин снимается в этом случае только если выполнены оба условия:
  run-id актора аутентифицирован (подписанный claim `run_id` агентского JWT;
  заголовок `X-Paperclip-Run-Id` при агентском API-ключе задаёт клиент и
  карантин никогда не снимает) и происхождение прогона входит в явный список
  внутренних источников (вызовы `assignment`/`automation`/`timer` с
  планировщиковыми wake-источниками). Ответы на вопросы из внешнего чата
  (`issue.interaction.respond`), побудки по комментариям, маркеры чата/вебхука и
  любой источник вне списка остаются в карантине.
- Задача в карантине получает отказ в учётных данных GitHub со структурированной
  причиной и путём выпуска (`POST /api/issues/:id/low-trust/promotions`).
- Миграция `0387_low_trust_internal_release_candidates` — пробный прогон: пишет
  аудит-строки `issue.low_trust_release_candidate` (id задач) для задач в
  карантине с доказанно внутренним происхождением и ничего в задачах не меняет.
  Оператор сверяет список и выпускает подтверждённые через endpoint promotion.
