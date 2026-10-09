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
- Навык `knowledge-distill` (каста curator) заменяет плагинный
  `paperclip-distill`.

## divergence

Раздел 6 архитектуры (K-5) реализован как рутина ядра поверх модуля знаний
K-1; перенос остальных знаний — K-6. Текст предложений пишет curator-навык,
не рутина (в архитектуре так и разделено).
