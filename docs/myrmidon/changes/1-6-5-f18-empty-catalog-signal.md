---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### The board raises an attention card when the gateway model catalog is empty (1.6.5 F-18)

- The spend collection sweep refreshes the model catalog from
  `/v1/model/info` on every pass. A successful refresh that returns 0 models
  now records an operator attention card: "Gateway model catalog is empty —
  check the accounting key". The usual cause is an accounting key created
  with a restricted model list (no default models): the gateway answers an
  empty list on a successful request, and every feature that reads the
  catalog (prices, model lists, entry limits) silently stops working.
- The card is per company and deduped: repeated empty sweeps keep the same
  card, and the first sweep that sees a non-empty catalog clears it — no
  dismissal bookkeeping. The first sweep right after the server start records
  the same way, so a misconfigured key surfaces immediately, not after one
  interval.
- The fix is operational, not a code change: re-create the accounting key
  (`MYRMIDON_LITELLM_KEY_SECRET`) with access to `/spend/logs/v2` and
  `/v1/model/info` and an empty model list (all models visible). The
  SETTINGS.md row now spells this out.

## changelog-ru

### Доска поднимает карточку внимания, когда каталог моделей шлюза пуст (1.6.5 F-18)

- Проход сбора трат обновляет каталог моделей из `/v1/model/info` на каждом
  проходе. Успешное обновление, вернувшее 0 моделей, теперь записывает
  операторную карточку внимания: «Gateway model catalog is empty — check the
  accounting key». Обычная причина — учётный ключ, созданный с ограниченным
  списком моделей (без моделей по умолчанию): шлюз отвечает пустым списком на
  успешный запрос, и все функции, читающие каталог (цены, списки моделей,
  лимиты входа), молча перестают работать.
- Карточка одна на компанию и дедуплицирована: повторные пустые проходы
  держат ту же карточку, а первый проход, увидевший непустой каталог, её
  снимает — без ручного закрытия. Первый проход сразу после старта сервера
  записывает так же, поэтому неправильный ключ всплывает сразу, а не после
  одного интервала.
- Исправление операционное, а не кодовое: пересоздать учётный ключ
  (`MYRMIDON_LITELLM_KEY_SECRET`) с доступом к `/spend/logs/v2` и
  `/v1/model/info` и пустым списком моделей (видны все модели). Строка
  SETTINGS.md теперь это прямо описывает.

## settings-en-replace

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->
| `MYRMIDON_LITELLM_KEY_SECRET` | M2-A | unset (off) | Name of the company secret holding the gateway key with access to `/spend/logs/v2` and `/v1/model/info` (for LiteLLM this is a virtual key with the right to read the spend log). The key must see ALL models: an empty model list (no restriction). A key created with a restricted model list makes `/v1/model/info` answer 0 models on a successful request, leaving the catalog empty and silently disabling prices, model lists and entry limits — the board raises an attention card when this happens | The value is read only for the duration of the pass, is not written to the log and is not stored; spend rows are attributed to agents by sha256 of bot key values — the values themselves do not leave the process. If the card appears, re-create the key with an empty model list |

## settings-ru-replace

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_LITELLM_KEY_SECRET` | M2-A | не задана (выкл) | Имя секрета компании, в котором лежит ключ шлюза с доступом к `/spend/logs/v2` и `/v1/model/info` (у LiteLLM это виртуальный ключ с правом чтения журнала трат). Ключ должен видеть ВСЕ модели: пустой список моделей (без ограничения). Ключ, созданный с ограниченным списком моделей, заставляет `/v1/model/info` отвечать 0 моделями на успешный запрос — каталог остаётся пустым, а цены, списки моделей и лимиты входа молча перестают работать; доска в этом случае поднимает карточку внимания | Значение читается только на время прохода, не пишется в лог и не хранится; строки трат атрибутируются агентам по sha256 значений ключей ботов — сами значения не покидают процесс. Если карточка появилась — пересоздать ключ с пустым списком моделей |
