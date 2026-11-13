---
divergence-section: Трек 1 — платформа
---

## changelog-en

### The "Review CI wait" monitor no longer wakes the reviewer onto a red head (EMPTY-RUNS-2B)

- The hand-off to review does not wake a reviewer while the pull request head is red (`wait_red`, OPE-12176) and arms the board's "Review CI wait" monitor instead. The tick of that monitor only asked whether CI was still running, so ten minutes later it woke the reviewer onto the same red head with "do not wait for CI, submit the decision now". When the head was red because main was red, the reviewer could only return the task and the executor then ran to find nothing to fix (13.11: one such executor run took 139 model calls and 5.9 M input tokens).
- The tick now applies the admission rule of the hand-off. While CI runs or cannot be read the monitor is re-armed as before; while the finished head is red it is re-armed too (`issue.monitor_deferred` with the reason `review_head_red`, next check in ten minutes). A green head, a critical issue, a task without a pull request or without hosted CI wake the reviewer as before.
- The wait on a red head is bounded by the CI-wait budget of a review stage (`REVIEW_CI_WAIT_MAX_ATTEMPTS`, 18 ticks of the monitor): past it the reviewer is woken as before, so a red head nobody fixes does not park the task for good.

## changelog-ru

### Монитор «Review CI wait» больше не будит ревьюера на красной голове (EMPTY-RUNS-2B)

- Сдача на ревью не будит ревьюера, пока голова пул-реквеста красная (`wait_red`, OPE-12176), и вместо этого взводит монитор доски «Review CI wait». Срабатывание монитора проверяло только, идёт ли ещё CI, поэтому через десять минут будило ревьюера на той же красной голове с указанием «не жди CI, выноси решение сейчас». Когда голова была красной из-за красного main, ревьюер мог только вернуть задачу, а исполнитель затем запускался, чтобы выяснить, что править нечего (13.11: один такой прогон исполнителя — 139 вызовов модели и 5,9 млн входных токенов).
- Срабатывание теперь применяет то же правило допуска, что и сдача. Пока CI идёт или не читается, монитор перевзводится как раньше; пока завершённая голова красная — тоже перевзводится (`issue.monitor_deferred` с причиной `review_head_red`, следующая проверка через десять минут). Зелёная голова, критичная задача, задача без пул-реквеста или без CI будят ревьюера как раньше.
- Ожидание на красной голове ограничено бюджетом ожидания CI стадии ревью (`REVIEW_CI_WAIT_MAX_ATTEMPTS`, 18 срабатываний монитора): после него ревьюера будят как раньше, так что красная голова, которую никто не чинит, не оставит задачу стоять навсегда.

## divergence

| EMPTY-RUNS-2B | Срабатывание монитора «Review CI wait» применяет правило допуска ревью по зелёной голове: при красной завершённой голове монитор перевзводится, ревьюера не будят (до исчерпания бюджета ожидания CI стадии) | `server/src/services/heartbeat.ts` (`dispatchClaimedIssueMonitor`, метка `myrmidon(EMPTY-RUNS-2B)`); свой код: `server/src/myrmidon/review-stage-recovery/policy.ts` (`decideReviewCiWaitTick`) | Сдача на ревью не будит ревьюера на красной голове, а монитор через 10 минут будил; при красном main это давало возврат задачи и пустой прогон исполнителя (13.11: OPE-13004, OPE-13014) | `server/src/__tests__/issue-monitor-review-ci-wait.myrmidon.test.ts`, `server/src/myrmidon/review-stage-recovery/policy.myrmidon.test.ts` (блок `decideReviewCiWaitTick`) | Когда вендор сам не будит участника стадии ревью по монитору ожидания CI на красной голове — удалить ветку `wait_red` в срабатывании монитора и `decideReviewCiWaitTick` | (этот PR) |
