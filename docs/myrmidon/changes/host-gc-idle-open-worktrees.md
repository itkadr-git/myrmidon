## changelog-en

### Host GC frees idle clean pushed clones of open tasks

The host clone GC (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) used to remove bot task clones only for
done and cancelled tasks. A clone of a task in `in_review`, `blocked` or `backlog` stayed on the disk with no end
date. On 16.11 the bots volume reached 100% with 234 such clones of 0.5-0.6 GB each, and 63 runs failed with
"No space left on device".

The GC now also frees a clone of an open task when all of these are true: the task is in `in_review`, `blocked`
or `backlog`; the board shows no live run on it (`executionRunId` and `checkoutRunId` are empty); nothing in the
clone changed for 6 hours (`IDLE_OPEN_CLONE_HOURS`, or `--idle-open-hours`); `git status --porcelain` is empty
(untracked service directories such as `node_modules` do not count); and `HEAD` is on a branch that the server
advertises (`git ls-remote`, nothing is fetched). If the bots volume has less than 10% free space, the idle time
is 1 hour. The bot checks the branch out again on its next run. Everything else is kept: dirty, unpushed,
younger, with a live run, in `todo` or `in_progress`, or when the board or the server does not answer.

The journal has `idle-open-clone-removed` (task, status, size, age) and `idle-open-clone-kept` (with the reason).
`--dry-run` shows the clones that would go in `plan.idleOpenClones` and as `idle-open-clone-would-remove`.

## changelog-ru

### Уборка хоста освобождает простаивающие чистые отправленные копии открытых задач

Уборка копий на хосте (`scripts/myrmidon/host-gc/host-clone-cache-gc.mjs`) удаляла копии задач ботов только для
задач в статусах done и cancelled. Копия задачи в `in_review`, `blocked` или `backlog` лежала на диске без срока.
16.11 том ботов дошёл до 100% из-за 234 таких копий по 0,5-0,6 ГБ, и упали 63 прогона с ошибкой
«No space left on device».

Теперь уборка освобождает и копию открытой задачи, когда выполнено всё: задача в `in_review`, `blocked` или
`backlog`; на доске по ней нет живого прогона (`executionRunId` и `checkoutRunId` пусты); в копии ничего не менялось
6 часов (`IDLE_OPEN_CLONE_HOURS` или `--idle-open-hours`); `git status --porcelain` пуст (неотслеживаемые служебные
каталоги вроде `node_modules` не считаются); `HEAD` лежит на ветке, которую объявляет сервер (`git ls-remote`,
ничего не скачивается). Если на томе ботов свободно меньше 10%, время простоя равно 1 часу. Бот снова проверит
ветку при следующем прогоне. Всё остальное остаётся: грязные, неотправленные, более свежие, с живым прогоном,
в `todo` или `in_progress`, а также когда доска или сервер не отвечают.

В журнале события `idle-open-clone-removed` (задача, статус, размер, возраст) и `idle-open-clone-kept`
(с причиной). `--dry-run` показывает копии, которые были бы удалены, в `plan.idleOpenClones` и событием
`idle-open-clone-would-remove`.
