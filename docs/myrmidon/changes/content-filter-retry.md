## changelog-en

### One content-filtered model reply no longer fails the whole run (CONTENT-FILTER-RETRY)

- When the model provider answered a bot's call with `finish_reason: content_filter` (an HTTP 200 reply cut off by the provider's safety filter, even for harmless work text), the bot ended the run at once with `content_policy_blocked`, and the board restarted the task from the beginning. Over 7 days 58 engineer runs (675 minutes) failed this way, five of the last 72 hours' runs after more than 10 minutes of work. The bot now re-issues the same model call up to twice per run in total (the session and the work done so far are kept); the third refusal of a run ends it as before, and the failure text says it repeated after 2 re-issued calls. Shipped as hermes patch 36; it takes effect when the bot image is rolled out.

## changelog-ru

### Один ответ модели, отсечённый фильтром содержимого, больше не убивает весь прогон (CONTENT-FILTER-RETRY)

- Когда провайдер модели отвечал на вызов бота `finish_reason: content_filter` (ответ HTTP 200, обрезанный фильтром безопасности провайдера, в том числе на безобидный рабочий текст), бот сразу завершал прогон ошибкой `content_policy_blocked`, а доска начинала задачу заново. За 7 суток так упали 58 прогонов инженеров (675 минут), из последних 72 часов — пять прогонов после более чем 10 минут работы. Теперь бот повторяет тот же вызов модели до двух раз за прогон суммарно (сессия и сделанная работа сохраняются); третий отказ в прогоне завершает его, как раньше, а текст ошибки говорит, что отказ повторился после 2 повторных вызовов. Оформлено патчем 36 к hermes; действует после выката образа ботов.
