## changelog-en

### Host cleanup removes closed-task clones after 3 hours, runs every 30 minutes and leaves no partial archives (OPE-13104)

- On 14.11 about 73 task clones (36 GB) were created in 4 hours, and the 24-hour retention with a pass every 2 hours made free space on the bot disk jump by 10-15 GB and fired HOST_DISK/BOTS_DISK alerts several times a day. The default clone TTL (`CLONE_TTL_HOURS`, `--clone-ttl`) is now 3 hours and the systemd timer runs the cleanup every 30 minutes (`OnCalendar=*-*-* *:10/30:00`). The rules that keep active clones and archive dirty ones first are unchanged.
- When archiving a clone or a runner task folder fails, the unfinished `.tar.zst`/`.tar.gz` file is now deleted. Before, every pass left 1-2 GB of a partial archive of a folder that could never be archived. The error text now carries the exit code and the signal, because stderr is often empty.

## changelog-ru

### Уборка хоста удаляет копии закрытых задач через 3 часа, запускается каждые 30 минут и не оставляет недописанных архивов (OPE-13104)

- 14.11 за 4 часа создалось около 73 рабочих копий задач (36 ГБ), а хранение 24 часа и проход раз в 2 часа заставляли свободное место на диске ботов прыгать на 10-15 ГБ и по нескольку раз в день поднимали тревоги HOST_DISK/BOTS_DISK. Теперь TTL копий по умолчанию (`CLONE_TTL_HOURS`, `--clone-ttl`) равен 3 часам, а таймер systemd запускает уборку каждые 30 минут (`OnCalendar=*-*-* *:10/30:00`). Правила «активные копии не трогать» и «грязные — сначала архив» не изменены.
- Если архивирование копии или папки задачи в раннере не удалось, недописанный файл `.tar.zst`/`.tar.gz` теперь удаляется. Раньше каждый проход оставлял 1-2 ГБ недописанного архива папки, которая не архивировалась никогда. В тексте ошибки теперь код выхода и сигнал, потому что stderr часто пустой.
