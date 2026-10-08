---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### Asymmetric debates engine (DEBATE-ASYM A)

- The board runs a structured disagreement about a task question between
  models of different families: a generator (constructive pole), a critic
  (adversarial pole, told it is penalized for a missed error), and a judge
  outside the dispute (a third family). The first answers are independent —
  neither debater sees the other's before the exchange starts. At most three
  rounds; the exchange stops early when the critic writes the `[AGREE]`
  marker, or when the total token ceiling is reached (a call that crosses the
  ceiling is recorded but not charged). The result — positions, the judge's
  verdict and the cost per role — lands on the task as a `debate-result`
  document, and the spend is written as task-level cost events, so the budget
  enforcement (BUDGET-CONFIG) sees it.
- The role configuration is live: `GET`/`PATCH /api/myrmidon/debate/settings`
  and Instance → General → "Asymmetric debates" (board reads, instance admin
  writes, the source of the value shown). A symmetric configuration (both
  debaters from one family, or the judge sharing a debater's family) is
  refused with the exact reason; `MYRMIDON_DEBATE_CONFIG` is the forced
  environment override only while nothing is saved.
- Start a debate for a task: `POST /api/myrmidon/companies/:companyId/debates/
  issues/:issueId/run`. The board runs it directly; an agent caller is gated
  on the `spend_above_threshold` class of the autonomy matrix (a debate
  spends gateway calls) — forbidden answers 403, approval_required answers 403
  with the approval code. Models default to free ones: qwen generator, glm
  critic, deepseek judge. The gateway contour falls back to the evals one
  (`MYRMIDON_EVALS_BASE_URL` / `MYRMIDON_EVALS_KEY_SECRET`) when the debate
  variables are unset.
- Model families come from one extensible table (the same rules
  EVALS-JUDGE-FAMILY introduced), so the cross-family check answers
  "which family is this model" identically in both contours.

## changelog-ru

### Движок асимметричных дебатов (DEBATE-ASYM A)

- Доска проводит структурированный спор по вопросу задачи между моделями
  разных семейств: генератор (конструктивная полярность), критик
  (адверсариальная, в промпте — штраф за пропущенную ошибку) и судья вне
  спора (третье семейство). Первые ответы независимые — ни один спорщик не
  видит ответ другого до начала обмена. Не больше трёх кругов; обмен
  останавливается досрочно, когда критик пишет маркер `[AGREE]`, или когда
  достигнут потолок токенов (вызов, пересёкший потолок, записывается, но не
  тарифицируется). Результат — позиции, вердикт судьи и стоимость по ролям —
  кладётся на задачу документом `debate-result`, расход пишется
  cost-событиями на уровне задачи, его видит бюджетный контроль
  (BUDGET-CONFIG).
- Конфигурация ролей живая: `GET`/`PATCH /api/myrmidon/debate/settings` и
  Instance → General → «Asymmetric debates» (чтение — доска, запись —
  админ экземпляра, источник значения показан). Симметричная конфигурация
  (оба спорщика из одного семейства или судья из семейства спорщика)
  отклоняется с точной причиной; `MYRMIDON_DEBATE_CONFIG` — принудительное
  env-переопределение, пока ничего не сохранено.
- Запуск дебатов по задаче: `POST /api/myrmidon/companies/:companyId/debates/
  issues/:issueId/run`. Доска запускает напрямую; агент проходит матрицу
  автономии по классу `spend_above_threshold` (дебаты расходуют шлюз) —
  forbidden даёт 403, approval_required — 403 с кодом approval. Модели по
  умолчанию бесплатные: qwen генератор, glm критик, deepseek судья. Контур
  шлюза падает на evals-контур (`MYRMIDON_EVALS_BASE_URL` /
  `MYRMIDON_EVALS_KEY_SECRET`), если дебатные переменные не заданы.
- Таблица семейств моделей одна и расширяемая (те же правила, что ввёл
  EVALS-JUDGE-FAMILY) — проверка «разных семейств» отвечает на «к какому
  семейству относится модель» одинаково в обоих контурах.

## divergence

| 1.7-DEBATE-ASYM-A | Движок асимметричных дебатов: роли генератор/критик/судья с проверкой разных семейств, ≤3 круга, потолок токенов, остановка по согласию, документ результата на задаче со стоимостью, cost-события на уровень задачи, запуск по задаче через API с матрицей автономии для агентов; живые настройки экземпляра с показом источника значения и env-переопределением. Чистый движок и контракт — в `@paperclipai/shared` (`myrmidon-debate.ts`), серверный контур — `server/src/myrmidon/debates/` | нет изменённых файлов вендора; изменённые наши: `server/src/app.ts` (+роуты), `server/src/services/instance-settings.ts` (+preserve `debate`), `packages/shared/src/{index,types/instance,validators/instance}.ts` (+контракт), `ui/src/pages/InstanceGeneralSettings.tsx` (+панель); новые: `packages/shared/src/myrmidon-debate{,.test}.ts`, `server/src/myrmidon/debates/*`, `ui/src/components/myrmidon/{debateApi.ts,DebateSettingsPanel.tsx,DebateSettingsPanel.myrmidon.test.tsx}`, `docs/myrmidon/guides/debate-asym{,.ru}.md` | Правило владельца 1.7: только асимметричные дебаты разных семейств с судьёй вне спора; у вендора дебатов нет | `packages/shared/src/myrmidon-debate.test.ts` (симметричная конфигурация отклоняется до единого вызова; остановка на 3-м круге и на потолке токенов; стоимость в документе), `server/src/myrmidon/debates/{service,gateway,settings}.myrmidon.test.ts` | Не ожидается: наша фича. Снятие: удалить модуль debates, контракт myrmidon-debate, панель и точки вставки, строки SETTINGS | (этот PR) |

## settings-en

| `MYRMIDON_DEBATE_CONFIG` | 1.7-DEBATE-ASYM-A | unset (built-in default) | Forced JSON override of the debate role configuration (`{generator,critic,judge}` model ids, optional `rounds` 1..3 and `tokenCeiling`) while nothing is stored in `instance_settings.general.debate`. Precedence: stored settings → env → default (free models qwen/glm/deepseek, 3 rounds, 50 000 tokens); read at run and PATCH time — no restart, the effective source is shown on the screen | Unset or empty — the next level applies. Malformed JSON or a symmetric configuration (one family for generator and critic, or the judge sharing a debater's family) — reported as the reason and refused at every level, never silently replaced. `PATCH /api/myrmidon/debate/settings` with `{settings: null}` clears the stored row. Full guide: [guides/debate-asym.md](guides/debate-asym.md) |
| `MYRMIDON_DEBATE_BASE_URL` / `MYRMIDON_DEBATE_KEY_SECRET` | 1.7-DEBATE-ASYM-A | unset (fall back to `MYRMIDON_EVALS_BASE_URL` / `MYRMIDON_EVALS_KEY_SECRET`) | The debate gateway contour: the chat-completions base URL and the *name* of the company secret holding the key (never the value). Run mutations answer 503 with the reason while unconfigured | Set either one — the pair must resolve or the contour stays off. `MYRMIDON_DEBATE_TIMEOUT_SEC` (default 120, 5..600) bounds one model call |
