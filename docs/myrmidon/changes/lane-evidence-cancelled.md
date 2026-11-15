## changelog-en

### Cancelled CI check runs no longer turn pull request lane evidence red when superseded (LANE-EVIDENCE-CANCELLED)

- Pull request lane evidence (`summarizeHeadLaneEvidence`) now treats cancelled (`cancelled`) check runs the same way as the task CI summary: a cancelled check run does not mark the lane as failed if it is not newer than a successful `CI result` for the same head commit.
- Real failures (`failure`, `timed_out`, etc.) continue to mark the corresponding lane as failed regardless of `CI result`.

## changelog-ru

### Отменённые проверки CI больше не делают красными доказательства дорожки при успешном CI result (LANE-EVIDENCE-CANCELLED)

- Расчёт доказательств дорожки PR (`summarizeHeadLaneEvidence`) теперь трактует отменённые проверки (`cancelled`) так же, как сводка CI: отменённая проверка не делает дорожку красной, если она не новее успешного `CI result` той же головы коммита.
- Настоящие падения (`failure`, `timed_out` и т.д.) по-прежнему переводят дорожку в статус `failure`, независимо от наличия `CI result`.
