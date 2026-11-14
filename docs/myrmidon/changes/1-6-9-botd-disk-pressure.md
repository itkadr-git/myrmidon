## changelog-en

### botd sees the real fill of the bot volume, and a reviewer's copy is released after the review stage (OPE-13107)

- On 14.11 the `disk-state.json` of a reviewer bot said `partitionPercent: 0`, `pressure: none` while the bot XFS volume
  was at 86% (threshold 85%), so the fast cleanup under pressure never ran. The board answers `0 / none` when it has no
  partition measurement (dockergate down or its sample stale), and botd took that for an empty disk.
- The board now marks that answer `partitionMeasured: false`. When the board has no measurement, botd measures the bot data
  volume itself (`statfs` of `/workspace`) and derives the level with the default thresholds (85% soft, 90% hard). When the
  local measurement also fails or reports 0% with used bytes, `disk-state.json` carries a `warning` and botd logs it, instead
  of a silent `none`. A measured board answer is never overridden.
- The copy of a reviewer is released when its review stage has moved on: the task is `in_review`, its execution state is
  `pending`, the current participant is not this bot, and this bot is not the assignee (executor). Its key leaves `protectKeys`,
  goes to `closedKeys`, and the copy becomes `closing`; a dirty or unpushed copy is still archived by botd, not dropped. An
  assignee's copy is never released by this rule, whatever stale review state the task keeps.

## changelog-ru

### botd видит настоящее заполнение тома бота, а копия ревьюера освобождается после стадии ревью (OPE-13107)

- 14.11 в `disk-state.json` бота-ревьюера стояло `partitionPercent: 0`, `pressure: none`, хотя том XFS ботов был заполнен
  на 86% (порог 85%), и быстрая уборка под давлением не срабатывала. Доска отвечает `0 / none`, когда у неё нет замера
  раздела (dockergate недоступен или замер устарел), а botd принимал это за пустой диск.
- Теперь доска помечает такой ответ `partitionMeasured: false`. Если замера у доски нет, botd сам меряет том данных бота
  (`statfs` от `/workspace`) и выводит уровень по порогам по умолчанию (85% — soft, 90% — hard). Если и локальный замер
  не удался или показал 0% при занятых байтах, в `disk-state.json` появляется `warning`, botd пишет его в журнал — вместо
  молчаливого `none`. Ответ доски с замером не переопределяется.
- Копия ревьюера освобождается, когда стадия ревью ушла дальше: задача в `in_review`, состояние исполнения `pending`,
  текущий участник — не этот бот, и бот не исполнитель (`assignee`). Ключ уходит из `protectKeys` в `closedKeys`, копия
  получает состояние `closing`; грязную или не запушенную копию botd по-прежнему архивирует, а не удаляет. Копию
  исполнителя это правило не закрывает никогда, какое бы старое состояние ревью ни осталось на задаче.
