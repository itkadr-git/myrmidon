## changelog-en

### Blocked issue monitors wake on schedule (OPE-7932)

Scheduled issue monitors now wake their assignee for `blocked` tasks as well as active/review tasks. Terminal tasks clear schedules; overdue schedules surface as `issue_monitor_overdue` in the operator Attention feed. Every skipped monitor is journaled with its reason, and existing terminal-task schedules are cleared by migration.

## settings-en-append

<!-- section: Track 2 — wake and run core -->
| `MYRMIDON_ADMIN_TOKEN` | Security harness fixture | unset | Synthetic forbidden environment key used only by the site-agent security harness; it is not read as a server setting | Never configure or supply this key to agents |

## changelog-ru

### Мониторы заблокированных задач срабатывают по расписанию (OPE-7932)

Запланированные мониторы теперь будят исполнителя и у задач в `blocked`, как и у активных задач и задач на ревью. У завершённых и отменённых задач расписание снимается; просроченные мониторы отображаются операторам в ленте внимания как `issue_monitor_overdue`. Причина каждого пропуска записывается в журнал, а существующие расписания терминальных задач очищаются миграцией.
