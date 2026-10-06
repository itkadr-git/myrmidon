---
settings-section: 1.6 — EVALS-A (reference tasks and the LLM judge)
---

## divergence-new

<!-- after: DM-PROGRESS: живые шаги в сообщении статуса Telegram-лички -->

### 1.6.3 — EVALS-JUDGE-FAMILY: пометка «судья того же семейства» в результатах эталонов (UI) и гайд

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.3-EVALS-JUDGE-FAMILY-UI | Пометка «судья того же семейства» в результатах эталонов: поле `sameFamily` в `JudgeTaskResult` и `EvalTaskScore` (детекция `isSameModelFamily`, судья и субъект из одного семейства моделей DashScope/Qwen), бейдж и подсказка на экране результатов эталонов (`ReferenceTaskEvalsPanel` — панель «Результаты эталонных задач» в настройках компании, `SameFamilyBadge` отрисовывается у каждой задачи с `sameFamily`), при этом `sameFamily` считается от модели **субъекта** — карточки агента оцениваемой роли (`subjectModelFromAgentCard`), а не от модели судьи, настройка `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` — упорядоченный список моделей судей, читается при каждом построении сервиса (`readEvalsSettings` на каждый вызов), смена списка действует на следующую оценку без перезапуска | server/src/myrmidon/evals/judge.ts, server/src/myrmidon/evals/service.ts, server/src/myrmidon/evals/domain.ts, server/src/myrmidon/evals/routes.ts, server/src/myrmidon/evals/{routes,evals.db}.myrmidon.test.ts, + server/src/myrmidon/evals/judge.family.test.ts, + ui/src/components/myrmidon/evals/SameFamilyBadge.tsx, + ui/src/components/myrmidon/evals/SameFamilyBadge.myrmidon.test.tsx, + ui/src/components/myrmidon/evals/ReferenceTaskEvalsPanel.tsx, + ui/src/components/myrmidon/evals/ReferenceTaskEvalsPanel.myrmidon.test.tsx, + ui/src/components/myrmidon/evals/evalsApi.ts, + server/src/myrmidon/evals/subject-model.myrmidon.test.ts, ui/src/pages/CompanySettings.tsx, ui/src/i18n/locales/{en,ru}.json, ui/src/i18n/myrmidon-locales/{en,ru}.json, docs/myrmidon/guides/reference-task-evals{,.ru}.md, docs/myrmidon/SETTINGS{,.ru}.md | Владелец видит, где оценку ставил судья того же семейства (агенты в основном на DashScope/Qwen — судья оценивает «своих»), и может поменять список судей без перезапуска | server/src/myrmidon/evals/judge.family.test.ts, server/src/myrmidon/evals/subject-model.myrmidon.test.ts, ui/src/components/myrmidon/evals/SameFamilyBadge.myrmidon.test.tsx, ui/src/components/myrmidon/evals/ReferenceTaskEvalsPanel.myrmidon.test.tsx | Когда вендор заведёт собственную метку семейства судьи и настройку приоритетов: удалить куски с метками myrmidon(1.6.3 EVALS-JUDGE-FAMILY) и тесты | [#529](https://github.com/itkadr-git/myrmidon/pull/529) |

## settings-en

| `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` | EVALS-JUDGE-FAMILY | `qwen-plus-free,qwen-plus,qwen-max` | Comma-separated ordered list of judge models to try in priority order for evaluation | Invalid format — the default list is used |

## settings-ru-append

<!-- section: 1.6 — EVALS-A (эталонные задачи и LLM-судья) -->

| `MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS` | EVALS-JUDGE-FAMILY | `qwen-plus-free,qwen-plus,qwen-max` | Разделённый запятыми упорядоченный список моделей судей для попыток в порядке приоритета при оценке | Неверный формат — используется список по умолчанию |
