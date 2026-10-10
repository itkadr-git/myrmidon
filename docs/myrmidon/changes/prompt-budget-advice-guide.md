## changelog-en

### Prompt-budget advice and deep analysis (PROMPT-BUDGET part C)

- The agent card's Overview tab carries a "Prompt budget advice" panel: the last run's
  prompt breakdown by parts, a concrete recommendation for every part whose share crosses
  30% (Critical from 50%; below 2000 prompt tokens no advice is produced — the thresholds
  are code constants, not settings), and a "Deep analysis" button that files a task for a
  cheap-model optimizer agent. The optimizer drafts instruction edits as a comment on that
  task; nothing is scheduled and nothing is changed automatically.
- The optimizer agent is the instance general setting `promptBudget.optimizerAgentId`
  (no environment variable); the deep POST answers 422 with a clear message when it is
  absent, not a uuid, the analysed agent itself, or not an agent of the company. Dedup:
  one deep task per target agent per run.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (company member), `POST .../advice/deep` (board). Operator guide:
  [guides/prompt-budget-advice.md](guides/prompt-budget-advice.md).

## changelog-ru

### Рекомендации по бюджету промпта и глубокий разбор (PROMPT-BUDGET, часть C)

- Вкладка обзора карточки агента несёт панель «Prompt budget advice»: разбивка промпта
  последнего прогона по частям, конкретная рекомендация по каждой части, чья доля
  пересекает 30 % (Critical с 50 %; ниже 2000 токенов промпта рекомендаций нет — пороги
  являются константами кода, а не настройками), и кнопка «Deep analysis», которая ставит
  задачу агенту-оптимизатору на дешёвой модели. Оптимизатор отвечает черновиком правок
  инструкций комментарием к этой задаче; ничего не планируется по таймеру и ничего не
  меняется автоматически.
- Агент-оптимизатор — общая настройка инстанса `promptBudget.optimizerAgentId`
  (переменной окружения нет); deep-POST отвечает 422 с понятным текстом, когда она
  отсутствует, не uuid, совпадает с анализируемым агентом или не агент этой компании.
  Дедупликация: одна задача глубокого разбора на целевого агента за прогон.
- API: `GET /api/myrmidon/companies/:companyId/prompt-budget/agents/:agentId/advice`
  (участник компании), `POST .../advice/deep` (доска). Руководство оператора:
  [guides/prompt-budget-advice.ru.md](guides/prompt-budget-advice.ru.md).

## settings-en-append

<!-- after-line: edits as a comment on that task. Nothing is scheduled and nothing is changed automatically. -->
Operator guide: [guides/prompt-budget-advice.md](guides/prompt-budget-advice.md).

## settings-ru-append

<!-- after-line: этой задаче. Автоматически ничего не меняется. -->
Руководство оператора: [guides/prompt-budget-advice.ru.md](guides/prompt-budget-advice.ru.md).