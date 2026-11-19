## changelog-en

### botd sees the real fill of the bot volume, and a reviewer's copy is released after the review stage (OPE-13107)

- On 14.11 the `disk-state.json` of a reviewer bot said `partitionPercent: 0`, `pressure: none` while the bot XFS volume
  was at 86% (threshold 85%), so the fast cleanup under pressure never ran. The board answers `0 / none` when it has no
  partition measurement (dockergate down or its sample stale), and botd took that for an empty disk.
- The board now marks that answer `partitionMeasured: false`. When the board has no measurement, botd measures the bot data
  volume itself (`statfs` of `/workspace`) and derives the level with the default thresholds (85% soft, 90% hard). When the
  local measurement also fails or reports 0% with used bytes, `disk-state.json` carries a `warning` and botd logs it, instead
  of a silent `none`. A measured board answer is never overridden.
- The copy of a review participant is released when its review is over. A task row of a bot that is not the assignee is
  closed only when the bot is a participant of a review stage of the task and is neither the current participant, nor the
  return assignee, nor the assignee; its key goes to `closedKeys`. The executor's copy is kept until the task returns to it
  (during a review the board makes the reviewer the assignee and keeps the executor as the return assignee). A dirty or
  unpushed copy is still archived by botd, not dropped.

## changelog-ru

### botd видит настоящее заполнение тома бота, а копия ревьюера освобождается после стадии ревью (OPE-13107)

- 14.11 в `disk-state.json` бота-ревьюера стояло `partitionPercent: 0`, `pressure: none`, хотя том XFS ботов был заполнен
  на 86% (порог 85%), и быстрая уборка под давлением не срабатывала. Доска отвечает `0 / none`, когда у неё нет замера
  раздела (dockergate недоступен или замер устарел), а botd принимал это за пустой диск.
- Теперь доска помечает такой ответ `partitionMeasured: false`. Если замера у доски нет, botd сам меряет том данных бота
  (`statfs` от `/workspace`) и выводит уровень по порогам по умолчанию (85% — soft, 90% — hard). Если и локальный замер
  не удался или показал 0% при занятых байтах, в `disk-state.json` появляется `warning`, botd пишет его в журнал — вместо
  молчаливого `none`. Ответ доски с замером не переопределяется.
- Копия участника ревью освобождается, когда ревью у него закончилось. Строка задачи бота, который не исполнитель,
  закрывается, только если бот — участник стадии ревью этой задачи и при этом не текущий участник, не возвращаемый
  исполнитель и не `assignee`; ключ уходит в `closedKeys`. Копия исполнителя сохраняется до возврата задачи (на время
  ревью доска делает `assignee` ревьюера, а исполнителя держит в `returnAssignee`). Грязную или не запушенную копию
  botd по-прежнему архивирует, а не удаляет.
