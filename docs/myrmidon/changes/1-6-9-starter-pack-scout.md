## changelog-en

### Starter-pack scout wakes before the first engineer run (1.6.9 OPE-13095)

- New instance setting `general.starterPackAgentId`. When it is set, a newly created task of an engineer wakes that scout agent first (wake reason `starter_pack_scout`) instead of the assignee. The scout only reads the code and writes the task document `starter-pack`.
- The scout may write exactly the document `starter-pack` on the task; a document with any other key is still refused with 403. Right after that document is saved, and as a fallback when the scout's run ends without one (any run status), the board wakes the assignee with the usual `issue_assigned` wake, once per task. There is no timeout: the end of the scout's run is the signal, so a task cannot hang on the scout.
- The scout is not placed when the setting is empty, the task already has a `starter-pack` document or the heading `### Стартовый пакет` in its description, or the assignee is not an engineer; the behaviour is then unchanged. Delivering the document to the engineer is a separate change (OPE-13086).

## changelog-ru

### Разведчик пишет стартовый пакет до первого прогона инженера (1.6.9 OPE-13095)

- Новая настройка инстанса `general.starterPackAgentId`. Когда она задана, новая задача инженера сначала будит агента-разведчика (причина побудки `starter_pack_scout`), а не исполнителя. Разведчик только читает код и пишет документ задачи `starter-pack`.
- Разведчику разрешено записать на задаче ровно документ `starter-pack`; документ с другим ключом по-прежнему отклоняется с 403. Сразу после сохранения этого документа, а резервно — когда прогон разведчика закончился без документа (любой статус), доска будит исполнителя обычной побудкой `issue_assigned`, один раз на задачу. Таймаута нет: сигнал — конец прогона разведчика, поэтому задача не может повиснуть на разведчике.
- Разведчик не ставится, если настройка пуста, у задачи уже есть документ `starter-pack` или заголовок `### Стартовый пакет` в описании, либо исполнитель не инженер; поведение тогда прежнее. Доставка документа инженеру — отдельное изменение (OPE-13086).
