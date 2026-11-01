## changelog-en

### OOM process-loss recovery is classified as `resource.oom` (1.6.6 OOM RECOVERY)

- When a finalized agent run has run-correlated OOM evidence from the container monitor, recovery factory creates a typed `resource.oom` action instead of an unexplained generic failure.
- OOM evidence must match the finalized run (and its issue); unrelated or missing evidence does not create an OOM recovery action.
- The action is routed to the infrastructure/DevOps recovery owner, uses the standard 60-minute recovery SLA, and keeps the evidence and run ID for operator diagnosis. The configured OOM runbook reference is shown in the recovery action.
- The issue recovery card displays a dedicated OOM label and headline. Operators should inspect the linked run evidence and follow the runbook before retrying or changing container resources.

## changelog-ru

### Оборванный из-за OOM прогон классифицируется как `resource.oom` (1.6.6 OOM RECOVERY)

- Если для завершённого прогона есть привязанное к этому прогону OOM-доказательство от монитора контейнеров, recovery factory создаёт типизированное действие `resource.oom`, а не необъяснимый общий failure.
- Учитываются только доказательства, совпадающие с прогоном и его задачей; при отсутствии события или при несоответствии recovery-действие OOM не создаётся.
- Действие направляется владельцу инфраструктурного/DevOps-восстановления, использует стандартный SLA 60 минут и сохраняет run ID и доказательства для диагностики оператором. В recovery action отображается настроенная ссылка на runbook OOM.
- Карточка восстановления задачи показывает отдельные подпись и заголовок OOM. Перед повтором прогона или изменением ресурсов контейнера оператор должен проверить связанное доказательство и выполнить runbook.
