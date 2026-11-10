## changelog-en

### Model Providers screen and fallback editor: full RU localization, correct pool counters and badges (OPE-12361)

- Model Providers screen and the gateway fallbacks editor are fully translated for the RU locale: account table headers (plan, actions), pool attention signals, live/total/exhausted/disabled counters with the "next reset" line, `Codex OAuth Login` (now shown only on ChatGPT-pool cards), `Show diff`, ok/error statuses, and the whole fallbacks editor (Save Changes, Fallback Chain, cycle detection, warnings, add-target placeholder).
- Pool channel summaries no longer count `error` accounts as live. The reset date now comes from the real channel data: the earliest still-future limit window across non-banned/non-disabled accounts, so a rotated stale cache (e.g. an outdated 21.10 reset) can no longer shadow the real upcoming reset; the connectors never carried a pool-level reset document, so that dead read path is gone.
- Change log rows render the real author name/email; every audit writer (gateway keys, models, fallbacks rollback, provider mutations) now persists the display name from the authenticated actor instead of `user:<id>`. The fallback role labels (agent/board/system/user) come from the locale catalog, so the English UI no longer renders Russian words.
- Pool models are no longer badged "Paid" (pools are subscriptions); the fallback editor stops flagging pool groups with false "single provider (openai)" / "Paid fallback channel" warnings by deriving the provider from the board channel registry (pool type) instead of the LiteLLM prefix, and `kie-gpt-6-luna` is no longer reported "Free" (strict paid-provider check).
- Fixed 404 on page open: the hindsight model-groups route is now mounted under the company-scope alias.
- RU/EN locale parity and the latin-scan guard updated accordingly.

## changelog-ru

### Экран «Провайдеры моделей» и редактор резервов: полная русская локализация, корректные счётчики и метки пулов (OPE-12361)

- Экран «Провайдеры моделей» и редактор резервов шлюза полностью переведены для русской локализации: заголовки таблицы учёток (тариф, действия), сигналы внимания пулов, счётчики live/total/exhausted/disabled со строкой «следующий сброс», `Codex OAuth Login` (теперь только на карточках ChatGPT-пулов), `Show diff`, статусы ok/error и весь редактор резервов («Save Changes», «Fallback Chain», обнаружение циклов, предупреждения, плейсхолдер добавления цели).
- Сводки по пулам больше не считают учётки в состоянии `error` живыми. Дата сброса берётся из реальных данных каналов: самая ранняя ещё не наступившая граница окна среди не забаненных/не отключённых учёток, поэтому устаревший кэш (например, протухший сброс 21.10) больше не заслоняет настоящий ближайший сброс; коннекторы никогда не отдавали документ сброса на уровне пула, и этот мёртвый путь чтения убран.
- В журнале изменений показывается реальное имя/почта автора: все писатели аудита (ключи шлюза, модели, откат резервов, мутации провайдеров) сохраняют отображаемое имя из аутентифицированного актора вместо `user:<id>`. Подписи ролей (агент/доска/система/пользователь) берутся из каталога локалей — английский интерфейс больше не показывает русские слова.
- Модели пулов больше не помечаются «Платно» (пулы — подписки); редактор резервов не выдаёт ложных предупреждений «single provider (openai)» / «Paid fallback channel» для групп пулов — провайдер берётся из реестра каналов доски (тип пула), а не из префикса LiteLLM; `kie-gpt-6-luna` больше не считается «Free» (строгая проверка платных провайдеров).
- Исправлен 404 при открытии страницы: маршрут hindsight model-groups смонтирован под company-scope алиасом.
- Обновлены проверки паритета RU/EN и латинский скан локалей.
