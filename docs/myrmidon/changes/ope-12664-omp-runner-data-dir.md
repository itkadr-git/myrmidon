## changelog-en

### omp SSH runner data on the bot data disk (OPE-12664)

- The runner compose template keeps workspace, home and host key under `OMP_RUNNER_DATA_DIR` (bind volumes) instead of named volumes in `/var/lib/docker`: agents clone and build repositories in the runner, gigabytes per agent, and on vm-core that landed on the root disk.

## changelog-ru

### Данные исполнителя omp — на диске данных ботов (OPE-12664)

- Шаблон compose исполнителя хранит рабочую папку, домашний каталог и ключ хоста в `OMP_RUNNER_DATA_DIR` (тома-привязки), а не в именованных томах `/var/lib/docker`. Агенты клонируют и собирают репозитории в исполнителе, по нескольку гигабайт на каждого, и на vm-core это попадало на корневой диск.
