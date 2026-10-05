## changelog-en

### Prompt-budget advice and deep analysis (PROMPT-BUDGET C)

- The agent card (Overview) shows what the last run's prompt was made of —
  which part dominates it and what to do about it. The advice is computed on
  request from the recorded breakdown; a "Deep analysis" button files a task
  for a cheap-model optimizer agent, which drafts instruction edits as a
  comment on that task. Nothing is scheduled and nothing is changed
  automatically.
- The static thresholds are code constants, not settings: a part is worth a
  recommendation from 30% of the prompt, is critical from 50%, and no advice
  is produced below 2000 prompt tokens.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member) returns the breakdown and the recommendations;
  `POST .../advice/deep` (board) answers 201 with the filed task, or 422 with
  a clear message when no optimizer agent is configured
  (`promptBudget.optimizerAgentId` in the instance general settings). See
  [SETTINGS.md](../SETTINGS.md).

## changelog-ru

### Совет по бюджету промта и глубокий анализ (PROMPT-BUDGET C)

- Карточка агента (обзор) показывает, из чего состоял промт последнего
  прогона — какая часть доминирует и что с этим делать. Совет считается по
  запросу из записанной разбивки; кнопка «Глубокий анализ» заводит задачу
  боту-оптимизатору на дешёвой модели, который черновик правок инструкций
  пишет комментарием в ту задачу. Ничего не планируется и не меняется
  автоматически.
- Статические пороги — константы кода, не настройки: часть достойна
  рекомендации с 30 % промта, критична с 50 %, а ниже 2000 токенов промта
  совет не выдаётся.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (участник компании) отдаёт разбивку и рекомендации; `POST .../advice/deep`
  (доска) отвечает 201 с заведённой задачей или 422 с понятным сообщением,
  когда бот-оптимизатор не настроен (`promptBudget.optimizerAgentId` в общих
  настройках инстанса). См. [SETTINGS.md](../SETTINGS.md).
