## changelog-en

### Strict release focus no longer freezes work that has no release label

With `runPriority.strictReleaseFocus` on, the board froze every task that did not carry the current
release label, and this included operations, business-bot and lead tasks that never belong to a
release. On the live board all bots share one company, and only 3 or 4 of 81 could work.

Strict focus now blocks only a task that carries a label of another release. A label counts as a
release label when its trimmed name looks like a release number (`1.8`, `1.6.9`) and differs from the
current release, case-insensitively. A task without a release label, a task with the current release
label, and a task with both the current and another release label all pass. Labels such as `bug` or
`ops` never affect the decision. Tasks the owner assigned by hand, a review the agent takes part in,
and the rule that focus is off when the current release has no open tasks stay as they were. The
same condition applies to the swarm queue, to idle pickup and to the run-start gate.

## changelog-ru

### Строгий фокус выпуска больше не замораживает задачи без метки выпуска

При включённом `runPriority.strictReleaseFocus` доска замораживала каждую задачу без метки текущего
выпуска, в том числе эксплуатацию, задачи бизнес-ботов и лидов, которые ни к какому выпуску не
относятся. На бою все боты работают в одной компании, и работать могли только 3–4 из 81.

Теперь строгий фокус блокирует только задачу с меткой другого выпуска. Меткой выпуска считается
метка, имя которой после обрезки пробелов похоже на номер выпуска (`1.8`, `1.6.9`) и не равно
текущему выпуску без учёта регистра. Задача без метки выпуска, задача с меткой текущего выпуска и
задача с метками текущего и другого выпуска проходят. Метки вроде `bug` или `ops` на решение не
влияют. Задачи, назначенные владельцем вручную, ревью с участием агента и правило «в текущем выпуске
нет открытых задач — фокус снят» не изменились. Одно условие действует в очереди роя, в подборе
простаивающего агента и в проверке при старте прогона.
