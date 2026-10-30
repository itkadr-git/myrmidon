---
divergence-section: Трек 6 — безопасность и модели
---

## changelog-en

### GUARDRAILS false-positive eval on the reference corpus as a CI check (1.7-GRD-CI)

- The 1.6.1 reference corpus now drives a CI gate: a pure harness
  (`server/src/myrmidon/guardrails/eval/evaluate.ts`) runs every registered
  rule over every labelled case and reports, per rule, support, TP/FP/FN,
  false blocks (a rule firing on a clean fixture), precision and recall.
  The blocking number is false blocks — target 0; any false block turns the
  check red, so a blocking mode can never be shipped blind.
- Rules: `injection` (wake-queue heuristic at the shipped default threshold)
  is active; `secret`/`pii` (the part-A output detectors) load optionally —
  while the part-A module is not on main the rules report
  `pending-base-layer` (coverage listed, not gating) and activate
  automatically once it merges, with no change to this code.
- The per-rule report is a committed, generated artifact
  (`report.json` / `report.md` next to the harness). CI recomputes it and
  fails on any drift: a detector or corpus change that moves false positives
  or misses cannot merge without the artifact diff showing it. Regenerate
  deliberately with `pnpm --filter @paperclipai/server exec tsx
  ../scripts/myrmidon/guardrails-eval/refresh.ts` — it refuses to write when
  the eval is red.
- Recall is measured and published, not gated: the committed report names
  every injection case the heuristic currently misses (6/20 flagged at the
  default threshold) — the evidence base for the guardrail-modes track that
  decides per-rule blocking.
- No runtime settings: the eval is CI-only, measuring the shipped defaults.

## changelog-ru

### GUARDRAILS: проверка ложных срабатываний на эталонном корпусе как шаг CI (1.7-GRD-CI)

- Эталонный корпус 1.6.1 подключён к CI-гейту: чистый харнесс
  (`server/src/myrmidon/guardrails/eval/evaluate.ts`) прогоняет каждое
  зарегистрированное правило по каждому размеченному кейсу и считает по
  правилу: support, TP/FP/FN, ложные блоки (правило сработало на чистой
  фикстуре), precision и recall. Блокирующее число — ложные блоки, цель 0;
  любой ложный блок красит проверку, поэтому блокирующий режим не может
  быть включён вслепую.
- Правила: `injection` (эвристика очереди пробуждений на shipped-пороге по
  умолчанию) активно; `secret`/`pii` (выходные детекторы части A) грузятся
  опционально — пока модуль части A не в main, правила отчитываются как
  `pending-base-layer` (покрытие показано, гейт не красят) и активируются
  сами после его слияния, без правки этого кода.
- Отчёт по правилам — закоммиченный генерируемый артефакт (`report.json` /
  `report.md` рядом с харнессом). CI пересчитывает его и падает при любом
  расхождении: правку детектора или корпуса, сдвинувшую ложные срабатывания
  или пропуски, нельзя слить так, чтобы дифф артефакта это не показал.
  Пересоздавать осознанно: `pnpm --filter @paperclipai/server exec tsx
  ../scripts/myrmidon/guardrails-eval/refresh.ts` — при красном eval
  отказывается писать.
- Recall измеряется и публикуется, но не гейтится: закоммиченный отчёт
  называет каждый injection-кейс корпуса, который эвристика пока пропускает
  (6/20 на пороге по умолчанию), — доказательная база трека режимов
  ограждений, который решает блокировку по правилу.
- Рантайм-настроек нет: eval живёт только в CI и измеряет shipped-умолчания.

## divergence

| 1.7-GRD-CI | Eval-харнесс ложных срабатываний ограждений по эталонному корпусу как проверка CI: чистый скоринг (precision/recall/ложные блоки по правилу), реестр правил с опциональной загрузкой детекторов части A (`pending-base-layer` до её мержа), закоммиченный генерируемый артефакт `report.json`/`report.md` с проверкой расхождения в тесте и скриптом регенерации; ложный блок на чистой фикстуре — красный | Вендор не тронут: только новые файлы `server/src/myrmidon/guardrails/eval/{evaluate,rules,report-files}.ts`, тест `eval.myrmidon.test.ts`, артефакты `report.{json,md}`, `scripts/myrmidon/guardrails-eval/refresh.ts`, руководства `docs/myrmidon/guides/guardrails-ci-corpus{,.ru}.md` | Блокирующие режимы 1.7 нельзя включать вслепую: CI должен считать ложные блоки на нейтральном эталонном корпусе (цель — 0) и показывать recall по каждому правилу до решения о блокировке | `server/src/myrmidon/guardrails/eval/eval.myrmidon.test.ts` (скоринг tp/fp/fn/precision/recall; ложный блок красит гейт; заведомо ложносрабатывающее правило валит проверку; закоммиченный артефакт равен пересчитанному — drift-сторож; pending-правила не гейтят; переразметка кейса валит drift-проверку) | Никогда, наш eval-слой. Снятие: удалить каталог `server/src/myrmidon/guardrails/eval/`, `scripts/myrmidon/guardrails-eval/` и файлы руководств | (этот PR) |
