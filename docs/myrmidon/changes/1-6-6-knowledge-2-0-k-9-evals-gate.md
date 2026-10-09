---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Knowledge module part K-9: the evals gate of knowledge (KNOWLEDGE-2.0 K-9)

- New `server/src/myrmidon/evals/knowledge-gate.ts`: the lifecycle hook —
  `rule.approved` / `skill.promoted` / `page.published` opens a judge run for
  the item (`eval_run` with `subject_kind` + `subject_ref`), and a drop beyond
  the threshold, **confirmed by the repeat run**, calls `knowledge.rollback`
  and leaves a card for the owner postfactum. A hallucination — a criterion
  named after the failure or the promise (`hallucination`, `no-invented-…`,
  `fabricat…`, `made-up`) scored zero — rolls back at once, without spending the
  repeat.
- New additive migration `0313_evals_knowledge_gate.sql`: nullable
  `subject_kind` / `subject_ref` on `myrmidon_eval_runs`, so a run names the
  knowledge item it gated. Runs that are not gate runs leave both null.
- The knowledge journal now carries a `knowledge.eval_gate` line per judged
  publication with `eval_run_id`, `delta`, `verdict` and `owner_notice`
  (`KnowledgeModule.recordGateJournal`), so the quality page answers "which
  judge run gated this item, and by how much did it move the caste".
- Budget by construction: at most two judge runs per publication (first +
  confirmation) — the threshold's repeat is the last run.
- Tests: `knowledge-gate.db.myrmidon.test.ts` — the decision table (pure) plus
  the end-to-end acceptance on a synthetic rule over embedded Postgres: a
  deliberately bad rule rolls back within ≤ 2 judge runs, a good rule stays on
  one run, a hallucination rolls back on one run, and the journal carries
  `eval_run_id` and `delta`.

## changelog-ru

### Модуль знаний, часть K-9: evals-ворота знания (KNOWLEDGE-2.0 K-9)

- Новый `server/src/myrmidon/evals/knowledge-gate.ts`: хук жизненного цикла —
  `rule.approved` / `skill.promoted` / `page.published` открывает прогон судьи
  для элемента (`eval_run` с `subject_kind` + `subject_ref`), а падение сверх
  порога, **подтверждённое повтором**, вызывает `knowledge.rollback` и
  оставляет карточку владельцу постфактум. Галлюцинация — критерий, названный
  по провалу или по обещанию (`hallucination`, `no-invented-…`, `fabricat…`,
  `made-up`), с нулём — откатывает сразу, не тратя повтор.
- Новая аддитивная миграция `0313_evals_knowledge_gate.sql`: nullable-колонки
  `subject_kind` / `subject_ref` в `myrmidon_eval_runs` — прогон называет
  элемент знания, который он проверял. У прогонов, не являющихся воротами,
  обе колонки пусты.
- Журнал знаний теперь получает строку `knowledge.eval_gate` на каждую
  проверенную публикацию с `eval_run_id`, `delta`, `verdict` и `owner_notice`
  (`KnowledgeModule.recordGateJournal`) — страница качества отвечает на вопрос
  «какой прогон судьи проверил этот элемент и на сколько он сдвинул касту».
- Бюджет по построению: не более двух прогонов судьи на публикацию (первый +
  подтверждающий) — повтор, который требует порог, и есть последний прогон.
- Тесты: `knowledge-gate.db.myrmidon.test.ts` — таблица решений (чистая) плюс
  сквозной приёмочный тест на синтетическом правиле поверх embedded Postgres:
  намеренно плохое правило откатывается за ≤ 2 прогона судьи, хорошее
  остаётся за один прогон, галлюцинация откатывает за один прогон, в журнале
  есть `eval_run_id` и `delta`.

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-9: evals-ворота знания

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-K9 | Публикация правила/навыка (и `deliver`-страницы) проверяется судьёй касты: хук `rule.approved`/`skill.promoted`/`page.published` → `eval_run` с `subject_kind` (`rule`/`skill`/`page`) и `subject_ref` (slug). Падение сверх порога с повтором → автоматический `knowledge.rollback` на последнюю хорошую ревизию и карточка владельцу постфактум; галлюцинация (нулевой критерий галлюцинации в рубрике) откатывает сразу, без повтора; при недоступной базовой линии (verdict `error`) элемент остаётся. Журнал знаний получает строку `knowledge.eval_gate` (`eval_run_id`, `delta`, `verdict`, `owner_notice`). Судья другого семейства — EVALS-JUDGE-FAMILY (существующий порог 5 пунктов с повтором). | Наши файлы: `server/src/myrmidon/evals/knowledge-gate.ts`, `server/src/myrmidon/evals/knowledge-gate.db.myrmidon.test.ts`, `packages/db/src/migrations/0313_evals_knowledge_gate.sql` (+ meta journal/snapshot); правки поверх части A (K-1): `server/src/myrmidon/knowledge/store.ts` (`recordGateJournal`), `server/src/myrmidon/knowledge/service.ts`, `server/src/myrmidon/evals/{domain,service,index}.ts`, `packages/db/src/schema/myrmidon_evals.ts` | Знание не должно попадать в работу касты без проверки: ворота превращают откат плохого правила из ручного решения в автоматическое последствие прогона судьи, а журнал делает причину отката воспроизводимой | `knowledge-gate.db.myrmidon.test.ts`: таблица решений (повтор обязателен, `error`/без базовой линии не откатывает, галлюцинация откатывает) + сквозной тест на синтетическом правиле поверх embedded Postgres (плохое правило — ≤ 2 прогона судьи и указатель назад, хорошее — один прогон и остаётся, галлюцинация — один прогон, строка журнала с `eval_run_id` и `delta` в обоих исходах) | Никогда, наше поведение. Колонки и строки журнала остаются; миграции идут только вперёд | (этот PR) |