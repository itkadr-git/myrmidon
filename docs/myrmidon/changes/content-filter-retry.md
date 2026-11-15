## changelog-en

### One content-filtered model reply no longer fails the whole run (CONTENT-FILTER-RETRY, OPE-13076)

- When the model provider answered a bot's call with `finish_reason: content_filter` (an HTTP 200 reply cut off by the provider's safety filter, even for harmless work text), the bot ended the run at once with `content_policy_blocked`, and the board restarted the task from the beginning. Over 7 days 58 engineer runs (675 minutes) failed this way, five of the last 72 hours' runs after more than 10 minutes of work. The bot now re-issues the same model call up to twice per call without consuming the turn's restart budget (`restart_count`), but only where the run used to fail at once: bots with a configured fallback model still switch to it as before; a refusal that outlasts the re-issues ends the run as before, and the failure text says it repeated after the re-issued calls. Shipped as hermes patch 36; it takes effect when the bot image is rolled out.

## changelog-ru

### Повтор после срабатывания фильтра содержимого не расходует счётчик перезапусков хода (CONTENT-FILTER-RETRY, OPE-13076)

- Когда провайдер модели отвечал на вызов бота `finish_reason: content_filter` (ответ HTTP 200, обрезанный фильтром безопасности провайдера, в том числе на безобидный рабочий текст), бот сразу завершал прогон ошибкой `content_policy_blocked`, а доска начинала задачу заново. За 7 суток так упали 58 прогонов инженеров (675 минут), из последних 72 часов — пять прогонов после более чем 10 минут работы. Теперь бот повторяет тот же вызов модели до двух раз на каждый вызов без расхода общего счётчика перезапусков хода (`restart_count`), но только там, где прогон раньше падал сразу: боты с настроенной резервной моделью по-прежнему переходят на неё, как раньше; отказ, переживший повторы, завершает прогон, как раньше, а текст ошибки говорит, что отказ повторился после повторных вызовов. Оформлено патчем 36 к hermes; действует после выката образа ботов.
