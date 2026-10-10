---
settings-section: 1.6 — EVALS-A (reference tasks and the LLM judge)
---

## changelog-en

### Cross-family judge for reference-task scoring (EVALS-JUDGE-FAMILY)

- The judge of an eval run comes from a model family different from the
  evaluated agent's. `server/src/myrmidon/evals/model-family.ts` maps model ids to
  families (qwen, gpt, claude, glm, deepseek, kimi, gemini, llama, mistral, yi,
  phi, o1, o3 and more; extensible in code). Matching is token-anchored
  (`deepyida` is not yi, `chaos` is not o3, `mystique`/`dolphin` are not phi).
- A prioritized judge list (UI setting / env forced override) is scanned
  top-down; the first entry of a different family judges. Default list: the free
  models the gateway serves (`qwen-plus-free, qwen-max-free, qwen-turbo-free`,
  `SERVED_FREE_GATEWAY_MODELS`, the trio `DEFAULT_EVALS_MODEL` verifies); a paid
  model judges only when the operator lists it.
- A gateway failure of the selected judge no longer aborts the run: the next
  candidate is tried, then `MYRMIDON_EVALS_MODEL` gets a last chance; the run
  fails only if the whole chain fails, rethrowing the last error.
- With no cross-family candidate the run is still scored and every task carries
  `sameFamily: true` plus a server-log warning (also set for tasks judged on the
  last-chance model). The agent and judging models are reported per task; the
  agent model is resolved at run time (`subjectModelFor`), no schema change.
- Guides: [evals-judge-family-selection.md](../guides/evals-judge-family-selection.md) / [RU](../guides/evals-judge-family-selection.ru.md).

## changelog-ru

### Судья эталонов из другого семейства моделей (EVALS-JUDGE-FAMILY)

- Судья прогона оценки выбирается из семейства, **отличного от семейства модели оцениваемого агента**: `server/src/myrmidon/evals/model-family.ts` сопоставляет идентификаторы моделей с семействами (qwen, gpt, claude, glm, deepseek, kimi, gemini, llama, mistral, yi, phi, o1, o3 …; таблица расширяется в коде). Совпадение — по границе токена: подстрока засчитывается только на начале строки или после `/ . _ -` (`deepyida` — не yi, `chaos` — не o3, `mystique`/`dolphin` — не phi).
- Приоритетный список судей (настройка интерфейса, env — принудительное переопределение) сканируется сверху вниз; судит первая запись, чьё семейство ≠ семейству модели агента. Список по умолчанию — только бесплатные модели, которые гейтвей этого развёртывания действительно обслуживает (`qwen-plus-free, qwen-max-free, qwen-turbo-free` — `SERVED_FREE_GATEWAY_MODELS`, та же тройка, что подтверждает `DEFAULT_EVALS_MODEL`); платная модель судит, только если оператор явно вынес её в список.
- Сбой гейтвея выбранного судьи больше не прерывает прогон: пробуется следующая кандидатура, а когда все кандидаты списка исчерпаны с ошибкой, последний шанс получает настроенная `MYRMIDON_EVALS_MODEL`. Прогон падает, только если не сработала вся цепочка; тогда проброшена последняя ошибка.
- Если кандидата другого семейства нет, прогон всё равно оценивается, и каждая задача получает пометку `sameFamily: true` в результате плюс предупреждение в журнал сервера — владелец видит, что судья оценивал «своих». Та же пометка стоит у задач, отсуженных last-chance моделью.
- Модель оцениваемого агента и модель-судья сообщаются по каждой задаче; модель агента вычисляется во время прогона из роли субъекта (`subjectModelFor`), изменений схемы не требуется.
- Гайды: [англ.](../guides/evals-judge-family-selection.md) / [рус.](../guides/evals-judge-family-selection.ru.md).

## settings-en

| `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` | EVALS-JUDGE-FAMILY | unset (built-in list of gateway-served free models: `qwen-plus-free, qwen-max-free, qwen-turbo-free`) | Comma-separated judge priority list (head = top priority). For a run that reports the agent model, the judge is the first entry from a different model family; when every entry shares the agent's family the run is still scored with the first candidate and flagged `sameFamily` in the result and the server log. A gateway error of the selected judge falls through to the next candidate and finally to `MYRMIDON_EVALS_MODEL` (flagged `sameFamily`), instead of aborting the run. The env is a forced override of the UI setting; both are re-read on every run, no restart needed | Empty/unset — the built-in gateway-served free list; a paid model is used as judge only when the operator lists it here |

## divergence-new

### EVALS-JUDGE-FAMILY — судья эталонов из другого семейства моделей

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| EVALS-JUDGE-FAMILY | Оценка эталона выставляется моделью другого семейства, чем модель оцениваемого агента: таблица семейств в коде с токено-якорным сопоставлением (qwen/gpt/claude/glm/deepseek/kimi/gemini/llama/mistral/yi/phi/o1/o3/…, расширяемая); для прогона с `agentModel` судья — первая запись приоритетного списка с семейством ≠ семейству агента; нет кандидатов другого семейства — прогон оценивается первым кандидатом с пометкой `sameFamily: true` и предупреждением в журнал; сбой гейтвея кандидата не прерывает прогон — следующий кандидат, затем настроенная `MYRMIDON_EVALS_MODEL` (пометка `sameFamily`), падение только при отказе всей цепочки; список по умолчанию — только реально обслуживаемые гейтвеем бесплатные модели (тройка qwen `-free`), платная модель судит только при явном включении в список; env `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` — принудительное переопределение, читается на каждый прогон без перезапуска. Аддитивно к EVALS-A, без изменений схемы: модель агента вычисляется из роли субъекта (`subjectModelFor`) | Наши файлы: `server/src/myrmidon/evals/model-family.ts` (новое), правки в `server/src/myrmidon/evals/{judge,routes,index}.ts` | Агенты сидят на DashScope (семейство qwen), судья по умолчанию тоже qwen — оценка «своих» завышает и маскирует деградации; невалидированные id в списке по умолчанию давали гарантированную ошибку гейтвея и прерывали прогон; владельцу видно, кто судил (OPE-4143, OPE-5462) | `server/src/myrmidon/evals/judge.family-selection.myrmidon.test.ts` (список по умолчанию целиком из обслуживаемых гейтвеем моделей и не-qwen-агенту даёт не-qwen судью; qwen-агент → не-qwen судья; нет другого семейства → sameFamily + предупреждение, оценка есть; 404 кандидата → следующий кандидат, прогон не прерван; вся цепочка кандидатов мертва → last-chance `deps.model` + sameFamily; отказ всей цепочки при candidates=[deps.model] → та же ошибка, что и раньше; токено-якорные регрессии yi/o1/o3/phi; платная модель вне списка не выбирается) | Никогда, наше поведение. Снятие: удалить `model-family.ts` и тест, вернуть прежний вызов `createJudge` без agentModel | (этот PR) |
