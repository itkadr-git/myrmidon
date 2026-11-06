## changelog-en

### Quota errors take the model-unavailable path; auto-resume re-arms only on operator action (OPE-11947)

- The Hermes adapters (gateway and local) now mark a run `model_unavailable`
  whenever the provider's overload, quota or maintenance text came back as the
  turn's content (`provider_error_as_content`), not only for Hermes' own "No
  reply" notice. Such a run is retried by the model-unavailable policy
  (30 min, 1 h ... 6 h, five attempts) instead of the 30 second transient pair.
  The replay evidence (`executionRecovery`) is unchanged.
- An agent whose last finished run is model-unavailable is no longer resumed
  on the 1/5/15 minute backoff: a resume wakes every task the agent is
  stranded on, and each new run failed on the same quota again. It returns on
  the long model-unavailable schedule counted from the end of that run: 30 min,
  1 h, 2 h, 4 h, then every 6 h (skip reason `model_unavailable_wait` while it
  waits). These resumes do not count towards the attempt cap and never give up,
  so an agent whose quota ran out comes back by itself no later than 6 hours
  after the quota resets. The series counter (`modelUnavailableResumes`) lives
  in the same state and is dropped when the last run is no longer
  model-unavailable; then the ordinary backoff and cap apply again.
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
- Агента, чей последний завершённый прогон «модель недоступна», больше не
  возобновляют по бэкоффу 1/5/15 минут: возобновление будит все задачи, на
  которых агент застрял, и каждый новый прогон снова падал на той же квоте.
  Он возвращается по длинному графику «модель недоступна», считая от конца
  этого прогона: 30 мин, 1 ч, 2 ч, 4 ч, далее раз в 6 ч (пока ждёт, причина
  пропуска `model_unavailable_wait`). Эти возобновления не входят в потолок
  попыток и никогда не ведут к сдаче, поэтому агент с исчерпанной квотой
  возвращается сам не позже чем через 6 часов после её сброса. Счётчик серии
  (`modelUnavailableResumes`) лежит в том же состоянии и сбрасывается, когда
  последний прогон уже не «модель недоступна»; тогда снова действуют обычный
  бэкофф и потолок.
- После сдачи автовозобновления (`agent.auto_resume_exhausted`) агента снова
  взводит только действие оператора: строка журнала активности
  `agent.resumed`, `agent.updated` или `agent.error_cleared`, записанная
  пользователем по этому агенту после сдачи. Одно изменение
  `agents.updated_at` (прогон, смена статуса) взводило его через несколько
  минут, и сдача не держалась.
