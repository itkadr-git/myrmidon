## changelog-en

### OPE-12577: the manager is woken after a final run guard stop

- A final run guard stop blocks the task and wakes the assignee's manager (`run_guard_stop_needs_input`). The stopped run still held its environment lease for a moment, an execution hold, so the manager's wake was parked as an execution wait and never ran: 5 such wakes ran for 235 stops in 72 h, and engineers sat idle on blocked tasks.
- The wake of the assignee's `reports_to` (or `adm`) passes the execution hold at enqueue and is not made stale by it at claim; the assignee and the blocked status stay as the escalation set them.

## changelog-ru

### OPE-12577: после финальной остановки защитой руководитель снова будится

- Финальная остановка прогона защитой блокирует задачу и будит руководителя исполнителя (`run_guard_stop_needs_input`). Остановленный прогон ещё мгновение держал аренду окружения, а это удержание исполнения, и побудка руководителя откладывалась навсегда: за 72 ч 5 побудок на 235 остановок, инженеры простаивали на заблокированных задачах.
- Побудка `reports_to` исполнителя (или `adm`) проходит удержание при постановке и не признаётся устаревшей при захвате; исполнитель и статус blocked остаются такими, какими их поставила эскалация.
