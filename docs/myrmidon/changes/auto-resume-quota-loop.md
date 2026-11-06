## changelog-en

### Quota errors take the model-unavailable path; auto-resume re-arms only on operator action (OPE-11947)

- The Hermes adapters (gateway and local) now mark a run `model_unavailable`
  whenever the provider's overload, quota or maintenance text came back as the
  turn's content (`provider_error_as_content`), not only for Hermes' own "No
  reply" notice. Such a run is retried by the model-unavailable policy
  (30 min, 1 h ... 6 h, five attempts) instead of the 30 second transient pair.
  The replay evidence (`executionRecovery`) is unchanged.
- Auto-resume no longer resumes an agent whose last finished run is
  model-unavailable (skip reason `model_unavailable`). A resume wakes every task
  the agent is stranded on, and each new run failed on the same quota again.
- After auto-resume gives up on an agent (`agent.auto_resume_exhausted`), only
  an operator action re-arms it: an `agent.resumed`, `agent.updated` or
  `agent.error_cleared` activity row written by a user for that agent after the
  give-up. A change of `agents.updated_at` alone (a run, a status change) used
  to re-arm it a few minutes later, so the give-up never held.

## changelog-ru

### Квотные ошибки идут по пути «модель недоступна»; автовозобновление взводится только действием оператора (OPE-11947)

- Адаптеры Hermes (шлюзовой и локальный) теперь помечают прогон
  `model_unavailable`, когда текст провайдера о перегрузке, квоте или
  обслуживании пришёл как содержимое ответа (`provider_error_as_content`), а не
  только для собственного уведомления Hermes «No reply». Такой прогон
  повторяет политика «модель недоступна» (30 мин, 1 ч ... 6 ч, пять попыток),
  а не обычная транзиентная пара по 30 секунд. Доказательства безопасного
  повтора (`executionRecovery`) не менялись.
- Автовозобновление больше не возобновляет агента, чей последний завершённый
  прогон «модель недоступна» (причина пропуска `model_unavailable`).
  Возобновление будит все задачи, на которых агент застрял, и каждый новый
  прогон снова падал на той же квоте.
- После сдачи автовозобновления (`agent.auto_resume_exhausted`) агента снова
  взводит только действие оператора: строка журнала активности
  `agent.resumed`, `agent.updated` или `agent.error_cleared`, записанная
  пользователем по этому агенту после сдачи. Одно изменение
  `agents.updated_at` (прогон, смена статуса) взводило его через несколько
  минут, и сдача не держалась.
