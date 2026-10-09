---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## settings-en-replace

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->
| `MYRMIDON_LITELLM_KEY_SECRET` | M2-A | unset (off) | Name of the company secret holding the gateway key with access to `/spend/logs/v2` and `/v1/model/info` (for LiteLLM this is a virtual key with the right to read the spend log). The key must see ALL models: an empty model list (no restriction). A key created with a restricted model list makes `/v1/model/info` answer 0 models on a successful request, leaving the catalog empty and silently disabling prices, model lists and entry limits — the board raises an attention card when this happens | The value is read only for the duration of the pass, is not written to the log and is not stored; spend rows are attributed to agents by sha256 of bot key values — the values themselves do not leave the process. If the card appears, re-create the key with an empty model list |

## settings-ru-replace

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_LITELLM_KEY_SECRET` | M2-A | не задана (выкл) | Имя секрета компании, в котором лежит ключ шлюза с доступом к `/spend/logs/v2` и `/v1/model/info` (у LiteLLM это виртуальный ключ с правом чтения журнала трат). Ключ должен видеть ВСЕ модели: пустой список моделей (без ограничения). Ключ, созданный с ограниченным списком моделей, заставляет `/v1/model/info` отвечать 0 моделями на успешный запрос — каталог остаётся пустым, а цены, списки моделей и лимиты входа молча перестают работать; доска в этом случае поднимает карточку внимания | Значение читается только на время прохода, не пишется в лог и не хранится; строки трат атрибутируются агентам по sha256 значений ключей ботов — сами значения не покидают процесс. Если карточка появилась — пересоздать ключ с пустым списком моделей |
