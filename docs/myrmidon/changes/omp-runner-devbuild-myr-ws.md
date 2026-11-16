## changelog-en

### OMP runner: rsync and devbuild in the image, optional devbuild wiring (1.6.9)

- The `agent-runtime-omp-ssh` image now includes `rsync` and the `devbuild` client (the same script the hermes bots use), so engineers on the omp runner can run tests and builds on the build VPS instead of asking for devbuild to be restored.
- The operator compose template takes optional `OMP_RUNNER_DEVBUILD_KEY` (host path of the key, mounted read-only at `/opt/devbuild-ssh/id_ed25519`), `DEVBUILD_HOST`, `DEVBUILD_USER` and `DEVBUILD_BASE`. Without them the runner behaves as before. The README lists the enabling steps.

## changelog-ru

### Раннер OMP: rsync и devbuild в образе, необязательное подключение devbuild (1.6.9)

- В образ `agent-runtime-omp-ssh` добавлены `rsync` и клиент `devbuild` (тот же скрипт, что у ботов hermes): инженеры на раннере omp запускают тесты и сборки на сборочном VPS и не просят «восстановить devbuild».
- Шаблон compose оператора принимает необязательные `OMP_RUNNER_DEVBUILD_KEY` (путь ключа на хосте, монтируется только на чтение в `/opt/devbuild-ssh/id_ed25519`), `DEVBUILD_HOST`, `DEVBUILD_USER` и `DEVBUILD_BASE`. Без них раннер работает как раньше. Шаги включения — в README.
