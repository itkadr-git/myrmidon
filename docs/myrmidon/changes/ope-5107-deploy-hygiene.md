## changelog-en

### Deploy hygiene: the deploy no longer fills the disk it deploys from (OPE-5107)

On 06.10 the root filesystem of the deploy host moved from 86 % to 92 % in
the hour one deploy of rc.3 took. Three separate leaks summed to it: the
predeploy database copy kept its Postgres data in an anonymous volume that
`docker rm -f` never removes (3.4 GB left by the 05.10 check, 3.6 GB more by
rc.3, both orphaned), the component images of past releases were never
deleted (four board generations at ~7.3 GB each plus three to four bot image
generations, about 33 GB), and the deploy started pulling the new images
without checking the disk could hold them.

- PREDEPLOY-DB-CHECK: the copy's data now lives in a NAMED volume of the run
  (`myr-predeploy-dbvol-<digest8>-<pid>`), mounted into the throwaway
  Postgres and removed by the same EXIT trap that removes the containers —
  on success, on failure and on an interrupt alike.
  `MYRMIDON_PREDEPLOY_KEEP=1` keeps the volume together with the stack and
  prints its name.
- Disk precheck: before the first image pull and the database dump,
  deploy.sh (and a standalone bot-image-rollout.sh or rollout-component.sh
  run) verifies the free space of the filesystem that holds /var/lib/docker
  (`df -P`). Below MYRMIDON_DEPLOY_MIN_FREE_GB (default 15 GiB) the deploy
  stops before anything changed and names the requirement, the current
  value and the cleanup candidates (`docker system df`). 0 switches the
  check off; a dry run prints the check with the current value instead of
  refusing.
- Image retention: after a SUCCESSFUL deploy (deploy.sh after its
  post-deploy steps; bot-image-rollout.sh after the bots moved) the local
  images of the deploy's component repositories older than
  MYRMIDON_DEPLOY_IMAGE_KEEP previous releases are removed by creation date
  (default 1: the current release plus the one before it, kept for a
  rollback; 0 switches the cleanup off). The repository list is
  MYRMIDON_DEPLOY_IMAGE_REPOS (default: the board, dockergate, fleetd and
  the three bot images). An image used by ANY container, running or
  stopped, is never removed — it is skipped with a log line and does not
  eat the keep budget. A cleanup failure is a WARNING, never a failed
  deploy.

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
