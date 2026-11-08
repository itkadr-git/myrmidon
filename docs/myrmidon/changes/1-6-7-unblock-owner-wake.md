## changelog-en

### The block owner's unblock wake is no longer cancelled as "assignee changed"

When the board blocks an issue and wakes its block owner with `issue_unblock_requested`
(stranded-issue disposition, routable blocked issues), that owner — typically a senior
agent asked to assign a final status — is usually not the assignee. The queued-run gate
cancelled every such run as `issue_assignee_changed`, so the block could never be resolved
and the same owner was woken again and again (on 2026-11-08 the operator agent spent 36 runs
in an hour on two issues this way). The gate now lets the run start when it is an automation
`issue_unblock_requested` wake, the issue is still `blocked`, and the run's agent is the
recorded block owner (`blockerMetadata.owner` or `unblockDescriptor.owner`); any other
non-assignee is cancelled as before, and a terminal issue still stops the run.

## changelog-ru

### Побудка владельца блока «разблокируй» больше не отменяется как «сменился исполнитель»

Когда доска блокирует задачу и будит владельца блока с причиной `issue_unblock_requested`
(обработка зависших задач, маршрутизация заблокированных), этот владелец — обычно старший
агент, которого просят назначить итоговый статус, — как правило не исполнитель. Проверка
очереди отменяла каждый такой прогон как `issue_assignee_changed`: блок никто не мог снять,
владельца будили снова и снова (08.11.2026 бот-оператор потратил так 36 прогонов за час на
две задачи). Теперь прогон стартует, если это автоматическая побудка `issue_unblock_requested`,
задача всё ещё `blocked` и агент прогона записан владельцем блока (`blockerMetadata.owner`
или `unblockDescriptor.owner`); любой другой не-исполнитель отменяется как раньше, задача
в конечном статусе по-прежнему останавливает прогон.
