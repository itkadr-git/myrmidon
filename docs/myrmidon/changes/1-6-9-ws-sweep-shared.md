## changelog-en

### Terminal-workspace sweep no longer blocks on shared project directories

The terminal-workspace sweep now archives `shared_workspace` rows of closed
(done/cancelled) issues without inspecting git. These rows point at the
project's shared directory, which has no per-task copy, is always dirty or
unmerged, and has nothing to delete. Previously every such row was blocked and
the board wrote an `issue_terminal_archive_blocked` event for each one (over
180 000 events), loading the board every 30 seconds. The sweep still requires a
closed issue tree, the cooldown and no active run, never writes the block event
for these rows, and works through the backlog in passes of up to 200 shared
rows, each archived by its own single-row update. For shared copies the sweep uses no
git and no GitHub API (only the terminal state of the issue tree), and a copy
with an open linked issue is not archived.

The shared backlog is walked in batches taken under `FOR NO KEY UPDATE SKIP LOCKED` with a pause (1 s by default, `MYRMIDON_WORKSPACE_SHARED_SWEEP_PAUSE_MS`) between passes, so sweepers in several processes never take or archive the same row twice.

## changelog-ru

### Сторож закрытия рабочих копий больше не блокируется на общих каталогах проектов

Сторож закрытия рабочих копий теперь архивирует строки `shared_workspace`
закрытых (done/cancelled) задач без проверки git. Такие строки указывают на
общий каталог проекта: копии задачи у них нет, он всегда «грязный» или
«не влит», удалять нечего. Раньше каждая такая строка блокировалась, и доска
писала по событию `issue_terminal_archive_blocked` на каждую (больше 180 000
событий), нагружая доску каждые 30 секунд. Сторож по-прежнему требует закрытое
дерево задач, cooldown и отсутствие активного прогона, не пишет событие
блокировки для этих строк и разбирает накопленное проходами до 200 общих
строк, каждая архивируется отдельным обновлением одной строки. Для общих копий сторож не
использует ни git, ни GitHub API (нужна только закрытость дерева задач), а копия с
открытой привязанной задачей не архивируется.

Накопленное разбирается пачками под блокировкой `FOR NO KEY UPDATE SKIP LOCKED` с паузой между проходами (по умолчанию 1 с, `MYRMIDON_WORKSPACE_SHARED_SWEEP_PAUSE_MS`): сторожа в нескольких процессах не берут и не архивируют одну строку дважды.
