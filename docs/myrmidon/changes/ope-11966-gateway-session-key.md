## changelog-en

### Bot LLM requests carry a stable conversation key (TOKEN-BURN F, OPE-11966)

The pool of ChatGPT accounts behind the LLM gateway caches a prompt only when the requests of one conversation
carry one stable key. Hermes sent none, so the pool saw a new session id (the call id) on every request and its
cache hit only 25-47% of the input.

- **Header.** The bot profile (`hermes/config.yaml`) now has a `providers.myrmidon-gateway` entry for the instance
  LLM gateway endpoint (the URL of `model.base_url`) with Hermes' vendor option
  `session_affinity_header: x-litellm-session-id`. Hermes puts the conversation key in that header on every request
  to the endpoint: the conversation root (stable across compaction rotation), else the Hermes session id, which is
  the board's session key of the run (`paperclip:company:<id>:agent:<id>:issue:<id>`, with the generation suffix
  when the board raises it). The gateway forwards the header to the pool for `chatgpt-pool/*` models only, where it
  becomes the ChatGPT `session_id`. For every other model the header is read by the gateway only (it groups traces).
- **Body.** The chat-completions body of such a request also carries `prompt_cache_key` (bot-runtime patch `28`): the
  header's own value, bounded to 64 characters the way every key is (a longer id becomes `pck_` plus a hash of
  it). A key pinned by the caller stays; an endpoint without the option, and api.openai.com, are unchanged.
- **Rollout.** The profile change is part of every gateway bot's `config.yaml`, so each bot restarts its gateway once
  when the board applies the new profile; the body key arrives with the new bot runtime image.
- **To verify.** In the pool's statistics (`stats/usage.db`, table `req`) requests after the rollout have
  `session_hash` and `cache_key_hash` set and `cached_tokens` rising; compare the share `sum(cached_tokens) /
  sum(in_tok)` against the period before. A bot's `config.yaml` holds the `providers:` block; a request to the
  gateway shows the `x-litellm-session-id` header.

## changelog-ru

### Запросы ботов к LLM-шлюзу несут стабильный ключ разговора (TOKEN-BURN F, OPE-11966)

Пул аккаунтов ChatGPT за LLM-шлюзом кэширует промпт, только если запросы одного разговора несут один стабильный
ключ. Hermes его не слал, поэтому пул видел новый session id (id вызова) в каждом запросе, и его кэш давал 25-47%
входа.

- **Заголовок.** В профиле бота (`hermes/config.yaml`) появилась запись `providers.myrmidon-gateway` для адреса
  LLM-шлюза экземпляра (URL из `model.base_url`) со штатной опцией Hermes
  `session_affinity_header: x-litellm-session-id`. Hermes кладёт ключ разговора в этот заголовок в каждом запросе к
  адресу: корень разговора (стабилен при ротации после сжатия), иначе id сессии Hermes — ключ сессии доски для
  прогона (`paperclip:company:<id>:agent:<id>:issue:<id>`, с суффиксом поколения, когда доска его поднимает). Шлюз
  пробрасывает заголовок в пул только для моделей `chatgpt-pool/*`, где он становится `session_id` ChatGPT. Для
  остальных моделей заголовок читает только сам шлюз (группирует трассы).
- **Тело.** Тело chat-completions такого запроса несёт ещё и `prompt_cache_key` (патч рантайма ботов `28`): то же
  значение, что в заголовке, ограниченное 64 символами, как любой ключ (более длинный id превращается в `pck_` и
  хеш). Ключ, заданный вызывающим, остаётся; адрес без опции и api.openai.com не меняются.
- **Выкат.** Изменение профиля входит в `config.yaml` каждого бота со шлюзом, поэтому при применении доской нового
  профиля каждый бот один раз перезапускает свой шлюз; ключ в теле приходит с новым образом рантайма ботов.
- **Как проверить.** В статистике пула (`stats/usage.db`, таблица `req`) у запросов после выката заполнены
  `session_hash` и `cache_key_hash`, а `cached_tokens` растёт; сравнить долю `sum(cached_tokens) / sum(in_tok)` с
  периодом до. В `config.yaml` бота есть блок `providers:`, запрос к шлюзу несёт заголовок `x-litellm-session-id`.
