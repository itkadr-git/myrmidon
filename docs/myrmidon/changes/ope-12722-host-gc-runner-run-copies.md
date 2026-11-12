## changelog-en

### Host GC removes stale run copies of the omp SSH runners (OPE-12722)

- An omp runner keeps a copy of the workspace for every run; a failed or cancelled run never removed its copy, and old copies were pruned only when the next run on that runner started. On 11.11 an idle fleet accumulated 47 GB of such copies, the bots disk filled up and nine bots went down. The host GC now also removes run copies older than 4 hours (`--run-copy-ttl`, at least 3) under the runners' root. The pass runs only when the runner root is configured: `--runner-root`, or `HOST_GC_RUNNER_ROOTS` (on vm-core, the line `HOST_GC_RUNNER_ROOTS=/srv/myrmidon-xfs/omp-runners` in `/etc/myrmidon-host-gc.env`). The repo systemd unit sets the variable; a host that runs the script through its own wrapper must configure the root itself, and a wrapper that calls the script once per bot root should pass `--runner-root` on one invocation only, otherwise the pass repeats per bot.

## changelog-ru

### Уборка хоста удаляет устаревшие копии прогонов исполнителей omp (OPE-12722)

- Исполнитель omp хранит копию рабочей папки на каждый прогон; упавший или отменённый прогон свою копию не удалял, а старые копии убирались только при старте следующего прогона на этом исполнителе. 11.11 простаивающий флот накопил 47 ГБ таких копий, диск ботов заполнился, и девять ботов встали. Теперь уборка хоста удаляет копии прогонов старше 4 часов (`--run-copy-ttl`, не меньше 3) в корне исполнителей. Проход выполняется только при заданном корне исполнителей: `--runner-root` или `HOST_GC_RUNNER_ROOTS` (на vm-core строка `HOST_GC_RUNNER_ROOTS=/srv/myrmidon-xfs/omp-runners` в `/etc/myrmidon-host-gc.env`). Юнит systemd из репозитория задаёт переменную сам; хост, который запускает скрипт через собственную обёртку, должен задать корень сам, а обёртка, вызывающая скрипт по разу на корень бота, должна передавать `--runner-root` только в одном вызове, иначе проход повторяется для каждого бота.
