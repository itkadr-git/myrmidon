---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### A retried run replaces its failed attempt's prompt in the hermes session (1.6.5)

- The bot runtime's gateway patch `12-stranded-run-turn-replace.patch` makes a
  `/v1/runs` run supersede the unanswered prompt(s) that earlier failed attempts
  left at the end of the session, instead of adding one more user row per retry.
  Before, a session that kept failing grew one row per attempt and the replay
  merged them into a single user message of megabytes, so every retry hit the
  provider's input limit again.
- Only stranded plain-text prompts that share the new prompt's first 256
  characters are replaced; answered turns, unrelated text, images and compaction
  summaries are never touched. `HERMES_KEEP_STRANDED_RUN_TURNS=1` turns it off.

## changelog-ru

### Повторный прогон заменяет промпт упавшей попытки в сессии hermes (1.6.5)

- Патч гейтвея среды ботов `12-stranded-run-turn-replace.patch`: прогон
  `/v1/runs` заменяет неотвеченные промпты, которые прежние упавшие попытки
  оставили в конце сессии, вместо новой пользовательской записи на каждый повтор.
  Раньше постоянно падающая сессия росла по записи на попытку, а при повторе они
  склеивались в одно сообщение в мегабайты, и каждый повтор снова упирался в
  лимит входа провайдера.
- Заменяются только оставшиеся без ответа текстовые промпты с тем же началом
  (первые 256 символов); отвеченные ходы, посторонний текст, изображения и
  сводки сжатия не затрагиваются. `HERMES_KEEP_STRANDED_RUN_TURNS=1` отключает.

## divergence

| 1.6.5-HERMES-STRANDED | Патч `12-stranded-run-turn-replace.patch` к hermes: `/v1/runs` заменяет оставшиеся без ответа промпты упавших попыток через `SessionDB.rewind_user_turn` | Наши файлы: `docker/bot-runtime/patches/12-stranded-run-turn-replace.patch` (правки `agent/session_persistence.py`, `gateway/platforms/api_server_runs.py`), `patches/README.md`, `docker/bot-runtime/Dockerfile`, `docker/bot-runtime/tests/stranded_run_turn.py` | Ход пишет строку пользователя до первого вызова модели, поэтому упавший прогон оставлял промпт хвостом сессии; доска шлёт новый промпт (не побайтово равный), и записи копились до 9,6 МБ в одном сообщении. Upstream принимает только побайтово равный хвост (`adopt_unanswered_turn`, канал личных сообщений) | `tests/stranded_run_turn.py` в сборке образа (реальная `SessionDB`: замена, ответ не трогается, чужой текст, изображения, отключение, сбой отката) | Снимается, когда upstream hermes заменит или усыновит оставшийся без ответа промпт на повторе `/v1/runs` с неравным текстом. Снятие: удалить патч, строку README, шаги Dockerfile и тест | (этот PR) |
