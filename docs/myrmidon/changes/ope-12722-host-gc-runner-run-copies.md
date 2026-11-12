## changelog-en

### Host GC removes stale run copies of the omp SSH runners (OPE-12722)

- An omp runner keeps a copy of the workspace for every run; a failed or cancelled run never removed its copy, and old copies were pruned only when the next run on that runner started. On 11.11 an idle fleet accumulated 47 GB of such copies, the bots disk filled up and nine bots went down. The host GC now also removes run copies older than 4 hours under the runners' root (`--runner-root` / `HOST_GC_RUNNER_ROOTS`), and the vm-core unit sets the root.

## changelog-ru

### Уборка хоста удаляет устаревшие копии прогонов исполнителей omp (OPE-12722)

- Исполнитель omp хранит копию рабочей папки на каждый прогон; упавший или отменённый прогон свою копию не удалял, а старые копии убирались только при старте следующего прогона на этом исполнителе. 11.11 простаивающий флот накопил 47 ГБ таких копий, диск ботов заполнился, и девять ботов встали. Теперь уборка хоста удаляет копии прогонов старше 4 часов в корне исполнителей (`--runner-root` / `HOST_GC_RUNNER_ROOTS`), а юнит vm-core задаёт этот корень.
