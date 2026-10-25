---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Knowledge distiller v2: closed tasks to suggestions (KNOWLEDGE-2.0 K-5)

- New server module `server/src/myrmidon/distill/`: `domain.ts` (pure
  filtering rules: silent `noise` drop, ≥1 internal source per proposal, the
  `life`-source exclusion for common sections (I-7), the ≤10 human package,
  the 1M-input-token / 30-min budget as a signal, auto-accept restricted to
  `glossary`/`releases`/`how-made`), `settings.ts` (the stored
  `general.knowledgeDistill` row + per-key env overrides, same resolution
  shape as foraging), `raw.ts` (raw material by `completedAt`: tasks closed
  in the pass window with their final comments, documents and work-product
  refs, capped at `maxTasksPerPass`, the private-contour split at the
  selection edge), `model.ts` (the free-model call through the same
  OpenAI-compatible gateway transport the debates use; one call per pass;
  the answer parsed leniently), `service.ts` (the pass: pick → call → filter
  → land suggestions through the K-1 knowledge module; zero pages created
  directly; the numeric report written as a `knowledge.distill.pass` event
  into the knowledge journal), `startup.ts` (the sweep: foraging-shaped
  timer, live settings read per tick, disabled by default), `index.ts`
  (barrel).
- The startup is wired into `server/src/index.ts` next to the foraging
  sweep: `startDistillSweep(db)` / `stopDistillSweep()`.
- New bundled skill
  `packages/skills-catalog/catalog/bundled/paperclip-operations/knowledge-distill/SKILL.md`
  (registered in the shipped-catalog list): the `knowledge-curator` playbook
  that replaces the plugin `paperclip-distill` skill — proposal texts for
  the suggestion queue, never pages, never unsourced claims.
- New pure-domain test `server/src/myrmidon/distill/distill-domain.test.ts`
  covering each K-5 criterion decidable without a board: silent noise, the
  source rule, the package cap, the budget signal, the life boundary, the
  settings resolution, the lenient parser, the window math.

## changelog-ru

- Дистиллятор v2: закрытые задачи → предложения знаний (сырьё по
  `completedAt`, один вызов бесплатной модели на прогон, шум отбрасывается
  молча, у каждого предложения ≥1 внутренний источник, life-источники не
  попадают в общие разделы, пакет человеку ≤10, бюджет 1M токенов/30 мин —
  сигнал, авто-принятие только `glossary`/`releases`/«как сделано»).
- Прогон не создаёт страниц: только предложения в гнезде K-1 и числовой
  отчёт в Журнале знаний (`knowledge.distill.pass`).
- Параметры окружения дистиллятора: `MYRMIDON_DISTILL_ENABLED`,
  `MYRMIDON_DISTILL_INTERVAL_SEC`, `MYRMIDON_DISTILL_WINDOW_SEC`,
  `MYRMIDON_DISTILL_MAX_INPUT_TOKENS`, `MYRMIDON_DISTILL_MAX_DURATION_SEC`,
  `MYRMIDON_DISTILL_MAX_TASKS`, `MYRMIDON_DISTILL_MODEL`,
  `MYRMIDON_DISTILL_GATEWAY_URL`, `MYRMIDON_DISTILL_KEY_SECRET`,
  `MYRMIDON_DISTILL_AUTO_ACCEPT`.
- Навык `knowledge-distill` (каста curator) заменяет плагинный
  `paperclip-distill`.

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-5: дистиллятор v2 (закрытые задачи → предложения)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-E | Рутина ядра «дистиллятор v2»: сырьё — задачи, закрытые в окне прогона (выборка по `completedAt`, финальные комментарии/документы/ссылки на артефакты, приватный контур отсекается на границе выборки); один вызов бесплатной модели на прогон (транспорт chat-completions как в дебатах, ключ — из роли-касты `knowledge-curator`); чистые фильтры домена (шум `noise` отбрасывается молча, ≥1 внутренний источник у предложения, life-источники не попадают в общие разделы — I-7, пакет человеку ≤10, бюджет 1M входных токенов / 30 мин — сигнал, не обрыв, авто-принятие только `glossary`/`releases`/«как сделано» с внутренними источниками); прогон не создаёт страниц — только предложения через модуль знаний K-1 и числовой отчёт в журнал (`knowledge.distill.pass`); свип по таймеру в форме foraging, выключен по умолчанию (`general.knowledgeDistill` / `MYRMIDON_DISTILL_ENABLED`); bundled-навык `knowledge-distill` (каста curator) заменяет плагинный `paperclip-distill` | Наши файлы: `server/src/myrmidon/distill/` (весь каталог), `packages/skills-catalog/catalog/bundled/paperclip-operations/knowledge-distill/SKILL.md`, `server/src/index.ts` (помечено `myrmidon(1.6.6-K5)`: старт/стоп свипа), `packages/skills-catalog/src/shipped-catalog.test.ts` (регистрация навыка) | Знание растёт из закрытых задач без копии доски (раздел 6 архитектуры): предложения с источниками и расходом прогона видны в Журнале знаний, человек получает пакет ≤10 | `distill-domain.test.ts` (чистые правила: молчаливый шум, источник, life-граница I-7 на синтетике, пакет ≤10, бюджет-сигнал, окно по completedAt, разрешение настроек, lenient-парсер модели) | Никогда, наше поведение. Снятие: удалить каталог `server/src/myrmidon/distill/`, навык и три помеченных строки в `index.ts` | (этот PR) |

Настройки, читаемые из `general.knowledgeDistill` с одноимёнными env-переопределениями (функция `MYRMIDON_DISTILL_ENABLED` выключена по умолчанию):

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_DISTILL_ENABLED` | KNOWLEDGE-2.0 | unset (off) | Master switch for the periodic closed-task distillation sweep; only exact `1` enables it | Unset or any value other than `1` keeps the sweep off; no timer/pass is started |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 | `3600` | Interval between distillation passes, in seconds | Non-integer or below 60 uses the default |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 | `604800` | Look-back window for tasks completed in the pass, in seconds | Non-integer or below 60 uses the default |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 | `1000000` | Input-token budget signal for a pass; reaching it is reported, not a hard truncation | Non-integer or non-positive uses the default |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 | `1800` | Duration budget signal for a pass, in seconds; reaching it is reported | Non-integer or non-positive uses the default |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 | `200` | Maximum completed tasks selected in one pass | Non-integer or non-positive uses the default |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 | `dashscope-qwen-flash` | Model name sent for the single completion request | Unset or empty uses the default |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 | unset | OpenAI-compatible chat-completions gateway address | Unset disables model-backed distillation; never logged |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 | unset | Name of the company secret containing the gateway API key; the secret value is resolved for the request and is never logged or stored | Unset disables model-backed distillation; set a secret name, never a raw key |
| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 | empty | Comma-separated section allowlist for auto-acceptance; domain rules still restrict eligible sections to glossary, releases and how-made with internal sources | Empty disables auto-acceptance |

