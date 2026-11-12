## changelog-en

### OMP git-checkout workspace sync (1.6.8 OMP-GIT-ONLY-SYNC)

- `omp_local` SSH execution supports `workspaceSync: "git_checkout"` to transfer only the Git bundle and checkout for each run.
- The shared local workspace is not snapshotted, copied back, merged, or locked; skills and agent configuration assets continue to be staged normally.
- The default `workspaceSync: "full"` behavior is unchanged. Non-Git workspaces fall back to full synchronization.

## changelog-ru

### Синхронизация OMP только через git checkout (1.6.8 OMP-GIT-ONLY-SYNC)

- `omp_local` при SSH-выполнении поддерживает `workspaceSync: "git_checkout"`: для каждого прогона передаются только Git-бандл и checkout.
- Общая локальная рабочая копия не снимается, не возвращается, не сливается и не блокируется; навыки и конфигурация агента по-прежнему доставляются как раньше.
- Поведение по умолчанию `workspaceSync: "full"` не изменилось. Для рабочих каталогов без Git используется полный режим.
