## settings-en-new

<!-- after: 1.7 — RUN-GUARD-LOOPS: read-only exploration and repeated-call stops -->

### Current-release focus and owner assignments

When `general.runPriority.currentRelease` is set and the company has an open, visible issue with that exact label (case-insensitive, surrounding whitespace ignored), swarm matching and idle pickup exclude other release labels. Review participation is unaffected. This exact-label filter is separate from the run-priority scoring substring comparison.

An explicit assignment by a board user is an exception only when the latest assignment audit record names the current agent and no later swarm claim exists. Automatic assignments do not qualify. Legacy assignments without matching audit evidence fail closed while focus is active: to restore the exception, a board user must explicitly reassign the issue (unassign it first if necessary so an assignment change is recorded). Once no current-release issues remain open, the filter no longer applies.

## settings-ru-new

<!-- after: 1.7 UI-2.0 ЯЗЫК: часовой пояс и форматы чисел и дат в общих настройках экземпляра (ia-v2 §2.3 п.11, §6.1 G10) -->

### Фокус текущего выпуска и ручное назначение

Если задан `general.runPriority.currentRelease` и в компании есть открытая видимая задача с точно такой меткой (регистр и пробелы по краям игнорируются), матчер роя и idle pickup исключают задачи других выпусков. Участие в ревью не ограничивается. Точное совпадение метки здесь отличается от сравнения подстрок при расчете приоритета прогонов.

Исключение действует только для явного назначения пользователем доски: последняя запись аудита назначения должна указывать текущего агента, а более позднего захвата роем быть не должно. Автоматическое назначение исключения не дает. Старые назначения без подтверждения в аудите при активном фокусе не проходят: пользователь доски должен явно назначить задачу заново (при необходимости сначала снять назначение, чтобы записалось изменение). Когда открытых задач текущего выпуска не остается, фильтр больше не действует.
