---
divergence-section: 1.6.1 — BOT-RUNTIME-TUNING, часть B: компилятор профиля
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Auxiliary calls of a bot have a cheap ceiling, never a paid fallback (1.6.5 BOT-RUNTIME-TUNING-AUX-CEILING)

- Profile cards now have a company-level fallback ceiling for auxiliary calls:
  `MYRMIDON_BOT_AUX_FALLBACK_MODELS` (a list of gateway model aliases, instance
  setting). The profile compiler writes it as
  `auxiliary.title_generation.fallback_chain` and
  `auxiliary.compression.fallback_chain` in the bot's `hermes/config.yaml`.
- Hermes walks an auxiliary task's `fallback_chain` before the main chain — the
  card's `models.fallbacks` and then the gateway's own LiteLLM ladder — so an
  auxiliary call whose own model refuses the request is served by another model
  of the same cheap class instead of climbing into a paid model. This is the
  fact of 02.10: the session title generator (`auxiliary.title_generation`) ran
  on the main provider with `response_format: json_schema`; the model rejected
  the schema, and the LiteLLM fallback chain served the title from a paid model.
- The entry route is resolved per profile: the card's own provider when it names
  one, otherwise the instance gateway endpoint with `base_url` and `key_env`
  spelled out (Hermes resolves a fallback entry on its own and inherits neither
  from the task's `model`). An entry that repeats the task's own model is
  dropped — it is not a fallback — and when no route can be resolved the chain
  is dropped with a compile warning while the auxiliary model itself is still
  written. The ceiling never covers `auxiliary.vision`: those entries must be
  vision-capable models, a class the list cannot vouch for.
- Dropping `response_format: json_schema` where a model does not implement it
  needs no Myrmidon change: Hermes keeps a per-route memo of rejected
  structured-output types (plus the provider profiles' declared unsupported
  formats) and drops the field before the first request, and the title
  generator falls back from strict JSON to a loose scan and then to first-line
  prose. What was missing was the routing: an auxiliary call now has its own
  cheap ceiling instead of the main chain.
- Example — a bot whose card pins no models, company defaults
  `MYRMIDON_BOT_AUX_TITLE_MODEL=myr-cheap-chat`,
  `MYRMIDON_BOT_AUX_FALLBACK_MODELS=myr-cheap-chat,myr-cheap-long`,
  `MYRMIDON_BOT_LLM_BASE_URL=https://llm.example.com/v1`,
  `MYRMIDON_BOT_LLM_API_KEY_ENV=MYRMIDON_BOT_LLM_API_KEY`:

  ```yaml
  auxiliary:
    title_generation:
      fallback_chain:
      - base_url: "https://llm.example.com/v1"
        key_env: "MYRMIDON_BOT_LLM_API_KEY"
        model: "myr-cheap-long"
        provider: "custom"
      model: "myr-cheap-chat"
  ```

## changelog-ru

### У вспомогательных вызовов бота появился дешёвый потолок, платного фолбэка больше нет (1.6.5 BOT-RUNTIME-TUNING-AUX-CEILING)

- У карточек ботов появился потолок фолбэка вспомогательных вызовов на уровне
  компании: `MYRMIDON_BOT_AUX_FALLBACK_MODELS` (список псевдонимов моделей
  шлюза, настройка инстанса). Компилятор профиля пишет его как
  `auxiliary.title_generation.fallback_chain` и
  `auxiliary.compression.fallback_chain` в `hermes/config.yaml` бота.
- Hermes проходит `fallback_chain` вспомогательной задачи раньше основной
  цепочки — `models.fallbacks` карточки, а затем собственной лестницы LiteLLM, —
  поэтому вспомогательный вызов, которому его собственная модель отказала,
  обслуживается другой моделью того же дешёвого класса, а не поднимается до
  платной. Это факт 02.10: генератор заголовков сессии
  (`auxiliary.title_generation`) ходил на основного провайдера с
  `response_format: json_schema`; модель схему отклонила, и заголовок обслужила
  платная модель из цепочки фолбэка LiteLLM.
- Маршрут записи решается на каждый профиль: провайдер карточки, если он назван,
  иначе эндпоинт шлюза инстанса с явными `base_url` и `key_env` (Hermes
  резолвит запись фолбэка сама и не наследует ни то, ни другое от `model`
  задачи). Запись, повторяющая собственную модель задачи, отбрасывается — это не
  фолбэк; если маршрут не разрешается, цепочка отбрасывается с предупреждением
  компиляции, а сама вспомогательная модель всё равно записывается. Потолок
  никогда не покрывает `auxiliary.vision`: там нужны vision-модели, класс,
  который список не подтверждает.
- Убирать `response_format: json_schema` там, где модель его не поддерживает,
  правкой Myrmidon не нужно: Hermes держит процессную память отклонённых типов
  структурного вывода по маршруту (плюс объявленные в профилях провайдеров
  неподдерживаемые форматы) и снимает поле до первого запроса, а генератор
  заголовков падает со строгого JSON на свободный разбор и затем на первую
  строку текста. Не хватало именно маршрутизации: теперь у вспомогательного
  вызова свой дешёвый потолок вместо основной цепочки.

## divergence

| BOT-RUNTIME-TUNING-AUX-CEILING | Вспомогательные вызовы профиля бота (генератор заголовков, компрессия сессии) получают дешёвый потолок фолбэка: настройка инстанса `MYRMIDON_BOT_AUX_FALLBACK_MODELS` (список псевдонимов моделей шлюза) переносится компилятором профиля в `auxiliary.title_generation.fallback_chain` и `auxiliary.compression.fallback_chain` записываемого `hermes/config.yaml`. Hermes обходит цепочку вспомогательной задачи раньше основной (у `auxiliary.<task>` есть `fallback_chain`, и он проверяется до `fallback_model`/`models.fallbacks` карточки и лестницы LiteLLM), поэтому отказ собственной модели вспомогательной задачи больше не поднимает вызов до платной модели. Записи цепочки пишутся с маршрутом: провайдер карточки, если он назван, иначе эндпоинт шлюза инстанса с явными `base_url`/`key_env` (Hermes резолвит запись фолбэка сама); запись, равная модели самой задачи, отбрасывается, при неразрешимом маршруте цепочка отбрасывается с предупреждением компиляции (`auxiliary.<task>.fallback_chain: …`), а модель задачи всё равно записывается; пустые значения и дубликаты отсеиваются, `auxiliary.vision` потолком не покрывается (нужны vision-модели). Дефолта у настройки нет — псевдонимы называет оператор, как и у моделей `AUX_TITLE`/`AUX_COMPRESSION`; вендорский код `response_format: json_schema` править не требуется: Hermes снимает поле по процессной памяти отклонений на маршруте, а генератор заголовков умеет свободный разбор | Наши файлы `server/src/myrmidon/bot-containers/{profile-compiler,profile-input,profile-ports}.ts` (маркеры `myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING)`), строки в `docs/myrmidon/SETTINGS.md`/`SETTINGS.ru.md`; вендор не тронут | Пункт релиза 1.6.5 (родитель 1.6.1 BOT-RUNTIME-TUNING, часть B): вспомогательные задачи — заголовок сессии и компрессия — ходили в основного провайдера, а при отказе модели (у заголовка `response_format: json_schema`) цепочка фолбэка поднималась до платной модели. Часть A (OPE-4773) закрыла окно и порог компрессии, часть B даёт дешёвый потолок для auxiliary. Факт 02.10 | `server/src/myrmidon/bot-containers/profile-compiler.myrmidon.test.ts` (блок `myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING) auxiliary fallback ceiling`: запись цепочки на провайдере карточки и на эндпоинте шлюза, компрессия, исключение vision, отброс записи-дубликата модели задачи, три warning-пути, отсутствие цепочки без потолка), `profile-input.myrmidon.test.ts` (парсер списка, чтение env, перенос в `instanceDefaults`), `profile-compile.myrmidon.test.ts` (env → `config.yaml` на полном цикле) | Никогда, наше поведение; уходит вместе со всей серией G (компилятор профиля контейнеров). При снятии: убрать блоки `myrmidon(BOT-RUNTIME-TUNING-AUX-CEILING)`, имя env `MYRMIDON_BOT_AUX_FALLBACK_MODELS` и строки SETTINGS | (этот PR) |

## settings-en-append

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->
| `MYRMIDON_BOT_AUX_FALLBACK_MODELS` | BOT-RUNTIME-TUNING-AUX-CEILING | unset | The cheap ceiling of the auxiliary fallback chains: comma-separated gateway model aliases the profile compiler writes as `auxiliary.title_generation.fallback_chain` and `auxiliary.compression.fallback_chain` for every auxiliary task it configures. Hermes walks these entries before the main chain (the card's `models.fallbacks`, then the gateway's own LiteLLM ladder), so an auxiliary call whose own model refuses the request — the fact of 02.10: the title call's `response_format: json_schema` was rejected and a paid model served the title — is answered by another model of the same cheap class. Each entry is written with its route: the card's provider when it names one, otherwise the instance gateway endpoint with `base_url` and `key_env` spelled out. An entry that repeats the task's own model is dropped (it is not a fallback), duplicates are folded away, and when no route can be resolved the chain is dropped with a compile warning while the auxiliary model itself is still written. The ceiling never covers `auxiliary.vision` — those entries must be vision-capable models | Read on every profile build; a change restarts bot containers. Unset or blank = no chain is written (Hermes's own policy: an auxiliary task on `provider: auto` follows the main chain). The card's `models.titleGeneration` / `models.compressionSummary` still pin the task's model; the ceiling is instance-wide and deliberately has no default — the operator names aliases the gateway actually knows |

## settings-ru-append

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_BOT_AUX_FALLBACK_MODELS` | BOT-RUNTIME-TUNING-AUX-CEILING | не задано | Дешёвый потолок цепочек фолбэка вспомогательных вызовов: список псевдонимов моделей шлюза через запятую, который компилятор профиля пишет как `auxiliary.title_generation.fallback_chain` и `auxiliary.compression.fallback_chain` для каждой настраиваемой вспомогательной задачи. Hermes обходит эти записи раньше основной цепочки (`models.fallbacks` карточки, затем собственная лестница LiteLLM), поэтому вспомогательный вызов, которому его собственная модель отказала — факт 02.10: у заголовка отклонили `response_format: json_schema`, и заголовок обслужила платная модель, — получает ответ от другой модели того же дешёвого класса. Каждая запись пишется со своим маршрутом: провайдер карточки, если он назван, иначе эндпоинт шлюза инстанса с явными `base_url` и `key_env`. Запись, повторяющая собственную модель задачи, отбрасывается (это не фолбэк), дубликаты отсеиваются, а при неразрешимом маршруте цепочка отбрасывается с предупреждением компиляции, при этом сама вспомогательная модель записывается. Потолок никогда не покрывает `auxiliary.vision` — там нужны vision-модели | Читается при каждой сборке профиля; изменение перезапускает контейнеры ботов. Не задано или пусто = цепочка не пишется (политика самого Hermes: вспомогательная задача с `provider: auto` идёт по основной цепочке). Модель задачи по-прежнему закрепляют `models.titleGeneration` / `models.compressionSummary` карточки; потолок действует на инстанс и умышленно не имеет умолчания — псевдонимы называет оператор, и только те, что шлюз действительно знает |