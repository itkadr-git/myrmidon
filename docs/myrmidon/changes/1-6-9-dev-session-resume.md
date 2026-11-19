## changelog-en

### Developer runs resume the task session instead of always resetting it (OPE-13087)

- Developers (engineers and reviewers) get no Hindsight memory, but their task session is meant to continue between
  runs. The board still dropped the saved session on every developer run, so each run started without a `sessionId`.
- The role-based reset is removed. A developer run now resumes the saved task session under the strategy from the card
  (`issue` by default). The other resets are unchanged: a wake that asks for a fresh session, a changed configuration
  and a long-task plan still start a new session.
- Comments and the adapter documentation that said developers never resume a session now describe the actual rule.

## changelog-ru

### Прогон разработчика продолжает сеанс задачи, а не сбрасывает его всегда (OPE-13087)

- Разработчикам (инженерам и ревьюерам) не подключают Hindsight, но сеанс задачи должен продолжаться между прогонами.
  Доска же обнуляла сохранённый сеанс при каждом прогоне разработчика, и прогон стартовал без `sessionId`.
- Сброс по роли убран. Прогон разработчика теперь возобновляет сохранённый сеанс задачи по стратегии из карточки
  (по умолчанию `issue`). Остальные сбросы не изменились: побудка с требованием свежего сеанса, смена конфигурации и
  план длинной задачи по-прежнему начинают новый сеанс.
- Комментарии и документация адаптера, где говорилось, что разработчик никогда не возобновляет сеанс, приведены к
  действительному правилу.
