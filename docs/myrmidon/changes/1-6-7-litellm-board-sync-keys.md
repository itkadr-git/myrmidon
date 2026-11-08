## changelog-en

### Board-to-gateway sync: provider and channel keys, order, pause, names, agent keys

The board registered models and channels in LiteLLM in ways the gateway ignores or rejects. All of it is
now checked against LiteLLM v1.104.1.

- **Keys travel as values.** LiteLLM has no secret manager here, so a `secrets/<name>` reference was stored
  as the key, and a plugin model went out with an empty one. The board now resolves the company secret and
  sends its value, for provider models, plugin models, channels and the startup reconciliation (which built
  its sync service without a resolver and failed on the first enabled model of a company). A secret with no
  value is an error, never an empty key.
- **Order is `litellm_params.order`.** `/model/update` writes only `litellm_params`, so the order, priority and
  disabled flags the board put in `model_info` were dropped. `priority`, `disabled` and `provider` are not
  LiteLLM parameters and are no longer sent. A deployment without an order is only used when no ordered one
  of its group is healthy.
- **Disabling a channel pauses it.** LiteLLM has no `disabled` parameter; it has a pause flag. Disabling calls
  `/model/block`, enabling calls `/model/unblock`; the router skips a paused deployment, and the definition
  and the stored key stay in the gateway. Only deployments stored in the gateway database can be paused. A
  channel can be created paused.
- **Removing a model works.** `/model/delete` takes only a deployment id; the board sent model names and every
  removal failed. It now looks the deployments up and deletes them by id. Switching a model off removes only
  the deployment on the provider's own endpoint; deployments from the static gateway config are never touched.
- **Key rotation keeps the group's other channels.** Rotating a provider key updated the first deployment under
  the model name and deleted the other ones. It now rotates only the deployment on the provider's endpoint and
  never deletes a channel on another endpoint.
- **The registry name can be set.** The model's LiteLLM name was always `<type>/<model name>`, so it could not
  match a group that already exists (`kimi/kimi-for-coding`). It can now be given when the provider is created
  (`litellmModelNames`) and changed with the model update (`litellmModelName`, while the model is disabled).
  The upstream model is always the provider's own model name. Registering the same name on the same endpoint
  again no longer adds a second deployment.
- **Agent keys are found where agents keep them.** The allowlist update looked for a `llm-gateway-key-<name>-<id>`
  secret that live agents do not have. It now follows the card's key binding (`MYRMIDON_LLM_API_KEY`, else
  `apiKey`) to the secret value and updates the key through `/key/update` by its sha256. Keys that allow all
  models are still left alone, and an empty allowlist is still never sent when models are switched off.

## changelog-ru

### Синхронизация доски со шлюзом: ключи провайдеров и каналов, порядок, пауза, имена, ключи агентов

Доска регистрировала модели и каналы в LiteLLM так, что шлюз это игнорировал или отклонял. Всё сверено с
LiteLLM v1.104.1.

- **Ключ передаётся значением.** Менеджера секретов в LiteLLM здесь нет, поэтому ссылка `secrets/<имя>`
  сохранялась как сам ключ, а модель плагина уходила с пустым. Теперь доска разрешает секрет компании и
  отправляет его значение: для моделей провайдеров, моделей плагинов, каналов и стартовой сверки (она
  создавала сервис синхронизации без разрешения секретов и падала на первой включённой модели компании).
  Секрет без значения — ошибка, а не пустой ключ.
- **Порядок — это `litellm_params.order`.** `/model/update` пишет только `litellm_params`, поэтому порядок,
  приоритет и признак отключения, которые доска клала в `model_info`, пропадали. `priority`, `disabled` и
  `provider` не параметры LiteLLM и больше не отправляются. Развёртывание без порядка используется, только
  когда ни одно развёртывание группы с порядком не здорово.
- **Отключение канала ставит его на паузу.** Параметра `disabled` в LiteLLM нет, есть флаг паузы. Отключение
  вызывает `/model/block`, включение — `/model/unblock`; роутер пропускает приостановленное развёртывание,
  а определение и сохранённый ключ остаются в шлюзе. Приостановить можно только развёртывание, хранящееся в
  базе шлюза. Канал можно создать сразу приостановленным.
- **Удаление модели работает.** `/model/delete` принимает только идентификатор развёртывания, а доска слала
  имена моделей, и любое удаление падало. Теперь она находит развёртывания и удаляет их по идентификатору.
  При выключении модели удаляется только развёртывание на адресе самого провайдера; развёртывания из
  статического конфига шлюза не затрагиваются никогда.
- **Смена ключа не трогает остальные каналы группы.** Смена ключа провайдера обновляла первое развёртывание
  с этим именем и удаляла остальные. Теперь обновляется только развёртывание на адресе провайдера, а канал на
  другом адресе не удаляется никогда.
- **Имя в реестре можно задать.** LiteLLM-имя модели всегда было `<тип>/<имя модели>`, поэтому не совпадало с
  уже существующей группой (`kimi/kimi-for-coding`). Теперь его можно указать при создании провайдера
  (`litellmModelNames`) и изменить при обновлении модели (`litellmModelName`, пока модель выключена). Модель
  у провайдера всегда берётся по его собственному имени. Повторная регистрация того же имени на том же адресе
  больше не создаёт второе развёртывание.
- **Ключи агентов ищутся там, где они лежат.** Обновление списка моделей искало секрет
  `llm-gateway-key-<имя>-<id>`, которого у живых агентов нет. Теперь доска идёт по привязке ключа в карточке
  (`MYRMIDON_LLM_API_KEY`, иначе `apiKey`) к значению секрета и обновляет ключ через `/key/update` по его
  sha256. Ключи «все модели» по-прежнему не трогаются, а пустой список при выключении моделей по-прежнему
  никогда не отправляется.
