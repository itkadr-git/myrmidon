## changelog-en

### Settings UI: attention feed windows screen (SETTINGS-UI C-4)

- The attention feed windows are editable from the instance settings: a new
  "Attention feed" panel edits how far back the feed looks for an unresolved
  failed or timed-out run (1–365 days, default 7) and how long it reuses the
  feed it built per company (0–300 seconds, default 45; `0` turns the cache
  off). The panel shows the bounds and the built-in default of each field, and
  marks whether the value in force comes from the saved settings row or from
  the default.
- The panel reads and writes through `GET`/`PATCH
  /api/myrmidon/attention-feed`, backed by the instance settings row
  (`attentionFailedRunHorizonDays`, `attentionFeedCacheTtlSeconds` in the
  general block). A save is a partial write: only the window the operator
  changed is written, and the change is audited per company. The feed picks the
  new value up on its next build — no restart. Neither window has an
  environment variable, so the stored row (then the built-in default) is the
  only source; a hand-edited value that is not a whole number within the bounds
  reads as the default, the same fallback the feed itself applies.
- The two windows are the stored keys introduced by the ATTENTION-WINDOW-CACHE
  change; this screen is their operator entry point, and the keys are defined
  once in `packages/shared/src/myrmidon-attention-feed.ts` so the feed, the
  route and the screen cannot drift apart.
- The panel is mounted in the instance general settings next to the other
  myrmidon panels; the other attention behaviours (the `AUTO-RESUME` and
  `EXECUTION-HOLD` attention passes) keep their own screens and are untouched
  here.

## changelog-ru

### Настройки: экран окон ленты внимания (SETTINGS-UI C-4)

- Окна ленты внимания правятся из настроек инстанса: новая панель «Лента
  внимания» задаёт, на сколько дней назад лента ищет неразрешённый упавший или
  превысивший таймаут прогон (1–365 дней, умолчание 7) и сколько секунд она
  переиспользует собранную по компании ленту (0–300 секунд, умолчание 45; `0`
  выключает кэш). Панель показывает границы и умолчание каждого поля и
  отмечает, откуда взято действующее значение — из сохранённой строки настроек
  или из умолчания.
- Панель читает и сохраняет через `GET`/`PATCH
  /api/myrmidon/attention-feed`, за которыми стоит строка настроек инстанса
  (`attentionFailedRunHorizonDays`, `attentionFeedCacheTtlSeconds` в блоке
  general). Сохранение — частичная запись: пишется только изменённое окно, и
  изменение попадает в аудит по каждой компании. Лента подхватывает новое
  значение при следующей сборке — без перезапуска. Ни у одного из окон нет
  переменной окружения, поэтому единственный источник — сохранённая строка (а
  затем умолчание); значение, поправленное руками и не являющееся целым числом
  в границах, читается как умолчание — тот же откат, что применяет сама лента.
- Эти два окна — хранимые ключи из изменения ATTENTION-WINDOW-CACHE; этот экран
  — их операторская точка входа, а сами ключи описаны один раз в
  `packages/shared/src/myrmidon-attention-feed.ts`, чтобы лента, маршрут и экран
  не разъезжались.
- Панель подключена в общих настройках инстанса рядом с остальными панелями
  myrmidon; прочие поведения внимания (проходы `AUTO-RESUME` и
  `EXECUTION-HOLD`) сохраняют свои экраны и здесь не тронуты.