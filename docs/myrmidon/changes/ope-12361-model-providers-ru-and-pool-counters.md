## changelog-en

### Model Providers screen and fallback editor: full RU localization, correct pool counters and badges (OPE-12361)

- Model Providers screen and the gateway fallbacks editor are fully translated for the RU locale: account table headers (plan, actions), pool attention signals, live/total/exhausted/disabled counters with the "next reset" line, `Codex OAuth Login` (now shown only on ChatGPT-pool cards), `Show diff`, ok/error statuses, and the whole fallbacks editor (Save Changes, Fallback Chain, cycle detection, warnings, add-target placeholder).
- Change log rows render the real author name/email; every audit writer (gateway keys, models, fallbacks rollback, provider mutations) now persists the display name from the authenticated actor instead of `user:<id>`.
- Pool channel summaries no longer count `error` accounts as live and drop stale per-account reset dates in the past, so the card matches `GET /api/myrmidon/companies/:cid/model-providers/:id/channels` (live/exhausted/error) and never shows an outdated "next reset".
- Pool models are no longer badged "Paid" (pools are subscriptions); the fallback editor stops flagging pool groups with false "single provider (openai)" / "Paid fallback channel" warnings by deriving the provider from the board channel registry (pool type) instead of the LiteLLM prefix, and `kie-gpt-6-luna` is no longer reported "Free" (strict paid-provider check).
- Fixed 404 on page open: the hindsight model-groups route is now mounted under the company-scope alias.
- RU/EN locale parity and the latin-scan guard updated accordingly.

## changelog-ru

### Экран «Провайдеры моделей» и редактор резервов: полная русская локализация, корректные счётчики и метки пулов (OPE-12361)

- Экран «Провайдеры моделей» и редактор резервов шлюза полностью переведены для русской локализации: заголовки таблицы учёток (тариф, действия), сигналы внимания пулов, счётчики live/total/exhausted/disabled со строкой «следующий сброс», `Codex OAuth Login` (теперь только на карточках ChatGPT-пулов), `Show diff`, статусы ok/error и весь редактор резервов («Save Changes», «Fallback Chain», обнаружение циклов, предупреждения, плейсхолдер добавления цели).
- В журнале изменений показывается реальное имя/почта автора: все писатели аудита (ключи шлюза, модели, откат резервов, мутации провайдеров) сохраняют отображаемое имя из аутентифицированного актора вместо `user:<id>`.
- Сводки по пулам больше не считают учётки в состоянии `error` живыми и отбрасывают устаревшие даты сброса в прошлом, поэтому карточка совпадает с `GET /api/myrmidon/companies/:cid/model-providers/:id/channels` (live/exhausted/error) и не показывает устаревший «следующий сброс».
- Модели пулов больше не помечаются «Платно» (пулы — подписки); редактор резервов не выдаёт ложных предупреждений «single provider (openai)» / «Paid fallback channel» для групп пулов — провайдер берётся из реестра каналов доски (тип пула), а не из префикса LiteLLM; `kie-gpt-6-luna` больше не считается «Free» (строгая проверка платных провайдеров).
- Исправлен 404 при открытии страницы: маршрут hindsight model-groups смонтирован под company-scope алиасом.
- Обновлены проверки паритета RU/EN и латинский скан локалей.
