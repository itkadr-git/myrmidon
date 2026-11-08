## changelog-en

### Gateway channels and fallbacks managed from the board (LITELLM-BOARD)

- `GET /api/myrmidon/companies/:companyId/litellm/channels` lists the gateway deployments again. The
  model-provider routes are mounted first and used to answer that path with
  `{channels: [], enabled: false}`. They now serve only
  `/model-providers/litellm/channels`, the model-group list of the provider screen.
- The fallback topology lives in the gateway only. `GET .../litellm/fallbacks` reads the live router
  settings; `PUT .../litellm/fallbacks` sends the whole list with `POST /config/update`. The board no
  longer keeps a copy of the topology in its own database, and a save the gateway refuses is no longer
  reported as stored. A `PUT` without a `chains` list answers 400 instead of clearing the list.
- The model catalog reads the provider of a model from `model_info.litellm_provider`
  (`custom_llm_provider` stays as the second choice). Before, every catalog row had no provider and
  every fallback save was refused for it.
- A fallback inside one provider (for example `zai-glm-5.3` to `zai-glm-5.3-flash`) is allowed. The
  answer lists it in `warnings`, as it lists a model whose provider the catalog does not know. A target
  that is not in the catalog, a loop, a free channel after a paid one and a cheaper channel after a
  dearer one are still refused with 422.
- `PUT .../litellm/fallbacks` stays behind the admin-key setting. Without it the answer is 503 with
  `code: litellm_gateway_not_configured` and `missing` — the names of the variables to set.

## changelog-ru

### Каналы и резервы шлюза управляются с доски (LITELLM-BOARD)

- `GET /api/myrmidon/companies/:companyId/litellm/channels` снова отдаёт развёртывания шлюза. Маршруты
  провайдеров моделей смонтированы раньше и отвечали на этот путь `{channels: [], enabled: false}`.
  Теперь они обслуживают только `/model-providers/litellm/channels` — список групп моделей экрана
  провайдеров.
- Топология резервов живёт только в шлюзе. `GET .../litellm/fallbacks` читает живые настройки роутера,
  `PUT .../litellm/fallbacks` отправляет весь список через `POST /config/update`. Копии топологии в
  собственной базе доски больше нет, и отказ шлюза больше не выдаётся за сохранённое. `PUT` без списка
  `chains` отвечает 400 и не стирает список.
- Каталог моделей берёт провайдера из `model_info.litellm_provider` (`custom_llm_provider` — второй
  выбор). Раньше у всех строк каталога провайдера не было, и любое сохранение резервов отклонялось.
- Резерв внутри одного провайдера (например, `zai-glm-5.3` на `zai-glm-5.3-flash`) разрешён. Ответ
  перечисляет такие случаи в `warnings` — так же, как модель, провайдера которой нет в каталоге.
  Цель вне каталога, петля, бесплатный канал после платного и дешёвый после дорогого по-прежнему
  отклоняются с 422.
- `PUT .../litellm/fallbacks` остаётся за настройкой админ-ключа. Без неё ответ — 503 с
  `code: litellm_gateway_not_configured` и `missing` — именами переменных, которые надо задать.

## settings-en-replace

| `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` | M2-B | unset (key management off) | Name of the company secret holding the gateway ADMIN key (for LiteLLM — the master key): it manages the agents' virtual keys and is never handed to an agent. It is used only to read key names and to issue or rotate one agent's key; the value is not written to the log. Without it, together with `MYRMIDON_LITELLM_BASE_URL`, the keys API answers 503 `enabled: false`, and the fallback endpoints answer 503 with `code: litellm_gateway_not_configured`, `enabled: false` and `missing` — the names of the variables to set. The same key reads and writes the gateway's fallback topology (`GET /router/settings`, `POST /config/update`); the board keeps no copy of it | — |

## settings-ru-replace

| `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` | M2-B | не задана (упр. ключами выкл) | Имя секрета компании, в котором лежит АДМИН-ключ шлюза (у LiteLLM — master key): им управляются виртуальные ключи агентов, агентам он не выдаётся. Только чтение имён ключей и выдача/ротация ключа одного агента; значение не пишется в журнал. Без него вместе с `MYRMIDON_LITELLM_BASE_URL` API ключей отвечает 503 `enabled: false`, а эндпоинты резервов отвечают 503 с `code: litellm_gateway_not_configured`, `enabled: false` и `missing` — именами переменных, которые надо задать. Этим же ключом доска читает и пишет топологию резервов шлюза (`GET /router/settings`, `POST /config/update`); своей копии она не хранит | — |
