---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
settings-section: Track 5 — operations
---

## changelog-en

### Knowledge module part L-4: POST-TASK-REFLECT lesson distillation (KNOWLEDGE-2.0 L-4)

- New `server/src/myrmidon/lesson-distill/`: the lessons agents retained in
  hindsight over the last 24 hours become knowledge suggestions. Units typed
  `lesson` (fact type, or the `lesson` tag on an untyped unit) are collected
  from every agent bank of the company — the bank resolution is the memory
  card's own rule (agent-card `adapterConfig`, else the plugin config) —
  grouped by normalized text, and a lesson seen **≥ 2 times** inside the
  window becomes one pending suggestion marked
  `[lesson-distill:regulation_candidate]` with `sourceKind: "run"` and the
  evidence (repeats + memory ids) in the rationale. A single mention stays in
  the bank: one mention is not yet a rule. The distiller never writes a page —
  the curator cast decides (§4.5).
- The pass is idempotent: a still-pending twin from a previous pass is
  refreshed (newer evidence) instead of duplicated; every company tick leaves
  one `knowledge.lesson_distill.pass` journal line with the counters and the
  window. Caps by construction: at most 10 suggestions and 500 raw lessons
  per pass, 200 per bank.
- The sweep (`startup.ts`, wired from `server/src/index.ts`) is a no-op until
  `MYRMIDON_LESSON_DISTILL_ENABLED=1`; defaults: hourly tick, 24 h window,
  threshold 2. Optional env: `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES`,
  `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS`,
  `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD`, and the memory service address
  `MYRMIDON_MEMORY_BASE_URL` / `MYRMIDON_MEMORY_API_KEY` (the stored memory
  card settings are used when the env is absent).
- Tests: `lesson-distill.myrmidon.test.ts` (the pure domain: window math,
  lesson typing, grouping, the ≥2 rule) and
  `lesson-distill-pass.db.myrmidon.test.ts` over embedded Postgres — two
  agents' identical lessons become one marked pending suggestion plus the
  journal line; a single mention yields nothing; a repeat outside the window
  does not count; a second pass refreshes instead of duplicating.

## changelog-ru

### Модуль знаний, часть L-4: дистилляция уроков POST-TASK-REFLECT (KNOWLEDGE-2.0 L-4)

- Новый `server/src/myrmidon/lesson-distill/`: уроки, которые агенты за
  последние сутки удержали в hindsight, превращаются в предложения знаний.
  Юниты типа `lesson` (по факт-типу или по тегу `lesson` у нетипизированного
  юнита) собираются из банков всех агентов компании — банк резолвится по
  правилу самой карточки памяти (`adapterConfig` карточки, иначе конфиг
  плагина), — группируются по нормализованному тексту, и урок, встреченный
  **≥ 2 раз** внутри окна, становится одним pending-предложением с меткой
  `[lesson-distill:regulation_candidate]`, `sourceKind: "run"` и доказательствами
  (повторы + id памятей) в rationale. Одно упоминание остаётся в банке: один
  раз — ещё не правило. Дистиллятор страницы не пишет — решает каста
  кураторов (§4.5).
- Проход идемпотентен: всё ещё pending-двойник из прошлого прохода обновляется
  (свежие доказательства), а не дублируется; каждый тик компании оставляет одну
  строку журнала `knowledge.lesson_distill.pass` со счётчиками и окном. Ограничения
  по построению: не более 10 предложений и 500 сырых уроков за проход, 200 на банк.
- Обход (`startup.ts`, подключён в `server/src/index.ts`) — no-op, пока не
  выставлен `MYRMIDON_LESSON_DISTILL_ENABLED=1`; значения по умолчанию: тик раз
  в час, окно 24 ч, порог 2. Необязательные env:
  `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES`, `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS`,
  `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` и адрес сервиса памяти
  `MYRMIDON_MEMORY_BASE_URL` / `MYRMIDON_MEMORY_API_KEY` (когда env нет, берутся
  сохранённые настройки карточки памяти).
- Тесты: `lesson-distill.myrmidon.test.ts` (чистый домен: математика окна,
  типизация уроков, группировка, правило ≥2) и
  `lesson-distill-pass.db.myrmidon.test.ts` поверх embedded Postgres — одинаковые
  уроки двух агентов дают одно помеченное pending-предложение и строку журнала;
  одно упоминание не даёт ничего; повтор вне окна не считается; второй проход
  обновляет, а не дублирует.

## settings-en

| `MYRMIDON_LESSON_DISTILL_ENABLED` | KNOWLEDGE-2.0 L-4 | off | Enables the hindsight lesson distillation sweep of the knowledge module (hourly; lessons repeated at least twice in the window become pending knowledge suggestions). Tuned by `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` (60), `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` (24) and `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` (2) | Unset or anything other than `1` — the sweep is a no-op |
| `MYRMIDON_DISTILL_ENABLED` | KNOWLEDGE-2.0 K-5 | off | Enables the closed-task knowledge distiller sweep. | Unset or anything other than `1` — the sweep is a no-op. |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Interval between distiller passes, in seconds. | Invalid, zero, or unset values use 86400. |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Lookback window for closed tasks, in seconds. | Invalid, zero, or unset values use 86400. |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | stored budget | Input-token signal threshold for one distiller pass. | The built-in budget applies when unset or invalid. |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | stored budget | Duration signal threshold for one distiller pass, in seconds. | The built-in budget applies when unset or invalid. |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | 150 | Maximum closed tasks selected per distiller pass. | Invalid, zero, or unset values use 150. |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | free | Free model name used by the distiller gateway call. | The built-in `free` model applies when unset. |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | stored card | OpenAI-compatible gateway address used by the distiller. | Unset uses the stored knowledge card address. |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | stored card | Name of the company secret used to authenticate the distiller gateway. | Unset uses the stored secret name; the secret value is never documented or logged. |
| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | empty | Comma-separated sections eligible for automatic acceptance. | Empty disables auto-accept; only supported sections are honored. |

## settings-ru

| `MYRMIDON_LESSON_DISTILL_ENABLED` | KNOWLEDGE-2.0 L-4 | выкл | Включает обход дистилляции уроков hindsight модуля знаний (раз в час; урок, повторённый не менее двух раз в окне, становится pending-предложением знаний). Настраивается `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` (60), `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` (24) и `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` (2) | Не задана или не `1` — обход ничего не делает |
| `MYRMIDON_DISTILL_ENABLED` | KNOWLEDGE-2.0 K-5 | выкл | Включает обход дистиллятора знаний по закрытым задачам. | Не задана или не `1` — обход ничего не делает. |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Интервал между проходами дистиллятора, в секундах. | Неверное, нулевое или отсутствующее значение заменяется на 86400. |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | 86400 | Окно поиска закрытых задач, в секундах. | Неверное, нулевое или отсутствующее значение заменяется на 86400. |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | бюджет | Сигнальный порог входных токенов одного прохода. | При отсутствии или ошибочности применяется встроенный бюджет. |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | бюджет | Сигнальный порог длительности прохода, в секундах. | При отсутствии или ошибочности применяется встроенный бюджет. |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | 150 | Максимум закрытых задач за проход дистиллятора. | Неверное, нулевое или отсутствующее значение заменяется на 150. |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | free | Имя бесплатной модели для вызова шлюза дистиллятора. | При отсутствии применяется встроенная модель `free`. |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | сохранённая карточка | Адрес OpenAI-совместимого шлюза дистиллятора. | При отсутствии используется адрес из сохранённой карточки знаний. |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | сохранённая карточка | Имя секрета компании для аутентификации вызова шлюза. | Используется сохранённое имя; значение секрета не документируется и не выводится. |
| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | пусто | Разделы для автоматического принятия через запятую. | Пустое значение выключает авто-принятие; учитываются только поддержанные разделы. |

## settings-en-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: prompt-budget advice and deep analysis -->

### 1.7 — KNOWLEDGE-2.0 L-4 (hindsight lesson distillation sweep)

The lesson distill sweep is a background worker of the knowledge module: once per hour it walks the active companies, reads the lessons their agents retained in hindsight over the last 24 hours, and turns every lesson repeated ≥ 2 times into one pending knowledge suggestion marked `[lesson-distill:regulation_candidate]` (sourceKind `run`, evidence in the rationale; the curator decides the rest). The sweep is off by default — `MYRMIDON_LESSON_DISTILL_ENABLED=1` enables it. `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` (default 60), `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` (default 24) and `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` (default 2) tune the pass; the memory service address comes from `MYRMIDON_MEMORY_BASE_URL` / `MYRMIDON_MEMORY_API_KEY` or the stored memory card settings.

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->

### 1.7 — KNOWLEDGE-2.0 L-4 (обход дистилляции уроков hindsight)

Обход дистилляции уроков — фоновый воркер модуля знаний: раз в час он проходит активные компании, читает уроки, которые их агенты удержали в hindsight за последние 24 часа, и каждый урок с ≥ 2 повторами превращает в одно pending-предложение знаний с меткой `[lesson-distill:regulation_candidate]` (sourceKind `run`, доказательства в rationale; дальше решает куратор). Обход выключен по умолчанию — включает `MYRMIDON_LESSON_DISTILL_ENABLED=1`. Настройки прохода: `MYRMIDON_LESSON_DISTILL_PERIOD_MINUTES` (по умолчанию 60), `MYRMIDON_LESSON_DISTILL_WINDOW_HOURS` (24) и `MYRMIDON_LESSON_DISTILL_REPEAT_THRESHOLD` (2); адрес сервиса памяти — `MYRMIDON_MEMORY_BASE_URL` / `MYRMIDON_MEMORY_API_KEY` либо сохранённые настройки карточки памяти.
