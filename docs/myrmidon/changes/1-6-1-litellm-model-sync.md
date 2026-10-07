---
divergence-section: 1.6.1 — MODEL-PROVIDERS: реестр model-провайдеров компании (часть A)
---

## changelog-en

### Model-provider registry syncs with the LiteLLM gateway (MODEL-PROVIDERS B)

- Part B of the model-providers epic: the enabled models of the company
  provider registry (part A) now propagate to the LLM gateway. At startup each
  company whose store holds the gateway admin key registers its enabled models
  in LiteLLM, reclaims stale registrations of its own provider credentials and
  re-applies the model allowlist of every agent gateway key; the
  enable/disable, key-rotation and provider-removal routes then propagate the
  same changes live. The gateway is configured with the single documented pair
  `MYRMIDON_LITELLM_BASE_URL` + `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` — the
  latter is the NAME of a company secret, the board authenticates with the
  resolved VALUE, and either unset keeps sync fully off (one skip line at
  startup, the provider routes behave exactly as part A). Requirement: the
  gateway runs with `STORE_MODEL_IN_DB=true` — model registrations reference
  provider credentials as `secrets/<name>`, which that mode resolves in the
  gateway's own store.
- A gateway failure during a live propagation answers 422
  `litellm_sync_failed`: the database state stays the source of truth and the
  gateway converges on the next mutation pass or the startup reconciliation.

## changelog-ru

### Реестр model-провайдеров синхронизируется с шлюзом LiteLLM (MODEL-PROVIDERS B)

- Часть B эпика model-providers: включённые модели реестра провайдеров компании
  (часть A) распространяются в LLM-шлюз. При старте каждая компания, у которой
  в хранилище секретов лежит админ-ключ шлюза, регистрирует свои включённые
  модели в LiteLLM, снимает устаревшие регистрации СВОИХ провайдерских
  креденталов и перезаписывает allowlist моделей у каждого агентского ключа;
  маршруты enable/disable, ротации ключа и удаления провайдера propagate-ют те
  же изменения наживую. Шлюз конфигурируется единственной задокументированной
  парой `MYRMIDON_LITELLM_BASE_URL` + `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` —
  вторая переменная является ИМЕНЕМ секрета компании, доска аутентифицируется
  разыменованным ЗНАЧЕНИЕМ; отсутствие любой из них полностью выключает
  синхронизацию (одна строка skip при старте, маршруты работают как в части A).
  Требование: шлюз работает с `STORE_MODEL_IN_DB=true` — регистрации моделей
  ссылаются на креденталы провайдеров как `secrets/<имя>`, что этот режим и
  разрешает в собственном хранилище шлюза.
- Сбой шлюза при живой propagate отвечает 422 `litellm_sync_failed`: состояние
  базы остаётся источником истины, шлюз сходится на следующем прогоне мутаций
  или при стартовой сверке.

## divergence

| 1.6.1-MP-B | Синхронизация включённых моделей реестра части A с registry LiteLLM: `litellm-sync/{port,client,service,lock}.ts` — клиент `/model/new`, `/model/delete`, `/model/info` (кредентал передаётся ссылкой `secrets/<имя>` — контракт `STORE_MODEL_IN_DB=true`, значение не покидает доску); `startup-reconciler.ts` — стартовая сверка по companies: включённые модели регистрируются, устаревшие регистрации СОБСТВЕННЫХ креденталов компании снимаются (чужие не трогаются), затем перезаписываются allowlist'ы агентских ключей; `agent-allowlist-handler.ts` — `/key/update` без поля `key` (значение ключа не ротируется) ставит агенту список включённых моделей; `routes-with-sync.ts` — POST models (enable/disable), PATCH с ключом (ротация) и DELETE провайдера распространяют изменение в шлюз под пер-компанийным гардом `lock.ts`; сбой propagate после записанной мутации — 422 `litellm_sync_failed`, состояние БД остаётся источником истины, расхождение сходит на следующем прогоне. Конфигурация — только задокументированная пара `MYRMIDON_LITELLM_BASE_URL` + `MYRMIDON_LITELLM_ADMIN_KEY_SECRET` (ИМЯ секрета; клиент получает ЗНАЧЕНИЕ, разыменованное через secretService); пара не задана — сверка логирует skip и не стартует против localhost с пустым ключом | Наши файлы: `server/src/myrmidon/litellm-sync/{port,client,service,lock,agent-allowlist-handler,startup-reconciler,index}.ts` и тесты; в части A: `server/src/myrmidon/model-providers/{routes-with-sync,wiring}.ts` (наш же файл wiring, метка A+B), `server/src/myrmidon/litellm-keys/agent-keys.ts` (один опциональный метод порта `setKeyAllowedModels` + `okStatuses` у `post`), `server/src/index.ts` (одна строка старта, метка), `server/src/app.ts` (одна строка: routes с sync, метка) | 1.6.1 MODEL-PROVIDERS: реестр провайдеров (часть A) без регистрации в шлюзе не даёт агентам модели — часть B доводит эпик до рабочего конца и выполняет заявленное обновление allowlist агентских ключей | `server/src/myrmidon/litellm-sync/litellm-sync.myrmidon.test.ts` (enable/disable/reconcile компании с фильтром чужих регистраций, ротация, unregisterModels, отсутствие значений секретов в payload), `litellm-sync-startup.myrmidon.test.ts` (skip без пары env, разыменование ИМЕНИ в ЗНАЧЕНИЕ, пропуск компании без значения секрета, вызов allowlist-пасса), `model-providers-sync-routes.myrmidon.test.ts` (propagate на toggle/rotate/delete, 422 `litellm_sync_failed`, no-sync-как-часть-A, allowlist-хук), `agent-allowlist-handler.myrmidon.test.ts` (пустой реестр не трогает ключи, отсутствие секрета — skip, пер-агентные сбои не роняют пасс) | Никогда, наше поведение. Удалить каталог litellm-sync, строку старта в index.ts, вернуть wiring/routes на часть A, убрать метод порта | (этот PR) |
