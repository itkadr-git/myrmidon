## changelog-en

### Deploy hygiene: the deploy no longer fills the disk it deploys from (OPE-5107)

On 06.10 the deploy host's root filesystem went from 86 % to 92 % in the hour of
one rc.3 deploy: the predeploy database copy kept its Postgres data in an
anonymous volume `docker rm -f` never removes (3.4 GB + 3.6 GB orphaned), images
of past releases were never deleted (~33 GB), and the deploy pulled new images
without checking the free space.

- PREDEPLOY-DB-CHECK: the copy's data lives in a named volume
  (`myr-predeploy-dbvol-<digest8>-<pid>`) removed by the run's EXIT trap on
  success, failure and interrupt. `MYRMIDON_PREDEPLOY_KEEP=1` keeps it and
  prints its name.
- Disk precheck before the first pull and the dump (deploy.sh, standalone
  bot-image-rollout.sh / rollout-component.sh): free space of the filesystem
  holding /var/lib/docker must reach `MYRMIDON_DEPLOY_MIN_FREE_GB` (default 15
  GiB, 0 = off), otherwise the deploy stops before anything changed and names
  the cleanup candidates (`docker system df`). A dry run prints the check.
- Image retention after a successful deploy: local images of
  `MYRMIDON_DEPLOY_IMAGE_REPOS` (board, dockergate, fleetd, three bot images)
  older than `MYRMIDON_DEPLOY_IMAGE_KEEP` previous releases (default 1; 0 = off)
  are removed. An image used by any container is never removed; a cleanup
  failure is a warning, not a failed deploy.

## changelog-ru

### Гигиена выката: выкат больше не забивает диск, с которого идёт (OPE-5107)

06.10 корень хоста выката уехал с 86 % до 92 % за час одного выката rc.3.
Сложились три утечки: копия базы преддеплой-проверки держала данные Postgres
в анонимном томе, который `docker rm -f` не удаляет (3,4 ГБ от проверки
05.10 и ещё 3,6 ГБ от rc.3 остались сиротами), образы прошлых выпусков
компонентов не удалялись (четыре поколения доски по ~7,3 ГБ и три-четыре
поколения образов ботов, суммарно около 33 ГБ), и выкат начинал скачивание
новых образов без проверки, что диск их вместит.

- PREDEPLOY-DB-CHECK: данные копии теперь живут в ИМЕНОВАННОМ томе запуска
  (`myr-predeploy-dbvol-<digest8>-<pid>`), смонтированном в Postgres копии, и
  удаляются тем же trap EXIT, что и контейнеры, — при успехе, сбое и
  прерывании. `MYRMIDON_PREDEPLOY_KEEP=1` оставляет том вместе со стеком и
  печатает его имя.
- Проверка места: до первого скачивания образа и до дампа deploy.sh (а
  также самостоятельный запуск bot-image-rollout.sh или
  rollout-component.sh) проверяет свободное место на ФС, где лежит
  /var/lib/docker (`df -P`). Ниже MYRMIDON_DEPLOY_MIN_FREE_GB (по умолчанию
  15 ГиБ) выкат останавливается до любых изменений и печатает, сколько
  требуется, сколько есть и кандидатов на очистку (`docker system df`).
  0 отключает проверку; в dry-run печатается план проверки с текущим
  значением.
- Ретенция образов: после УСПЕШНОГО выката (deploy.sh после post-deploy
  шагов; bot-image-rollout.sh после переезда ботов) локальные образы
  репозиториев компонентов старше MYRMIDON_DEPLOY_IMAGE_KEEP предыдущих
  выпусков удаляются по дате создания (по умолчанию 1: текущий выпуск плюс
  один предыдущий для отката; 0 отключает чистку). Список репозиториев —
  MYRMIDON_DEPLOY_IMAGE_REPOS (по умолчанию: доска, dockergate, fleetd и три
  образа ботов). Образ, который использует ЛЮБОЙ контейнер (работающий или
  остановленный), не удаляется никогда — он пропускается со строкой в логе
  и не расходует бюджет ретенции. Сбой чистки — WARNING, а не упавший
  выкат.
