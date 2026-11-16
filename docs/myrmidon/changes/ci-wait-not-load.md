## changelog-en

### A task waiting for CI of its own PR is neither active load nor cooled

On 16.11 between 10:26 and 10:40, 8 to 13 of 14 engineers had no run. Each
had 2 to 5 of their own tasks in `todo` (45 in total) with an open PR waiting
for CI: the bot hands the task back to `todo` while CI runs. Two mechanisms
froze them. The active-task limit counted `todo` and `in_progress` tasks and
discounted a CI wait only for `in_progress` ones, so the engineer stayed "busy"
and received no new task. The `no_progress` cooling (EMPTY-RUNS-1) froze the
task after a run without a visible result: 555 pickups were skipped in six
minutes, while only 3 free ready tasks were in the queue.

Now a `todo` task whose open PR (draft or ready) has CI `queued` or
`in_progress` on the current head is discounted from the load like an
`in_progress` one (the 15-minute rule stays, so a fresh push is not discounted
at once), and the `no_progress` cooling is not applied to it while that CI
runs. Tasks without a PR and PRs without running CI behave as before. A
`ci_completed` wake already thaws a frozen task at once and is covered by a
test.

## changelog-ru

### Задача, ждущая CI своего PR, не считается активной нагрузкой и не охлаждается

16.11 с 10:26 до 10:40 без прогона были 8–13 из 14 инженеров. У каждого было
2–5 своих задач в `todo` (всего 45) с открытым PR, который ждёт CI: бот
возвращает задачу в `todo`, пока идёт CI. Заморозили их два механизма. Лимит
активных задач считал `todo` и `in_progress`, а ожидание CI вычитал только у
`in_progress`, поэтому инженер оставался «занят» и не получал новой задачи.
Охлаждение `no_progress` (EMPTY-RUNS-1) замораживало задачу после прогона без
видимого результата: за шесть минут пропущено 555 подборов, а свободных
готовых задач в очереди было только 3.

Теперь задача в `todo`, у которой открытый PR (черновой или готовый) имеет CI
`queued` или `in_progress` на текущей голове, вычитается из нагрузки так же,
как `in_progress` (правило 15 минут сохранено, свежий пуш не вычитается сразу),
а охлаждение `no_progress` к ней не применяется, пока идёт этот CI. Задачи без
PR и PR без идущего CI ведут себя как прежде. Пробуждение `ci_completed` уже
сразу размораживает замороженную задачу, это покрыто тестом.
