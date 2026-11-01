## changelog-en

### PREDEPLOY-IO throttles the throwaway database copy at the Docker data device

- `predeploy-board-check.sh` applies `--device-read-bps` and
  `--device-write-bps` to the throwaway Postgres container. The default is
  30,000,000 bytes/s (30 MB/s), configurable with
  `MYRMIDON_PREDEPLOY_IO_RATE`; restore, `ANALYZE`, readiness probes and other
  `docker exec` work run inside that throttled container.
- The backing device comes from `MYRMIDON_PREDEPLOY_IO_DEVICE` when set;
  otherwise the script resolves the device carrying DockerRootDir with
  `findmnt` and fails closed if it cannot identify one.
- Dry-run output shows the effective device and limits; fake-Docker tests assert
  both Docker flags.

## changelog-ru

### PREDEPLOY-IO ограничивает дисковый ввод-вывод копии базы

- `predeploy-board-check.sh` передаёт `--device-read-bps` и
  `--device-write-bps` контейнеру временного Postgres. По умолчанию это
  30 000 000 байт/с (30 MB/s), настройка — `MYRMIDON_PREDEPLOY_IO_RATE`;
  restore, `ANALYZE`, readiness-пробы и остальные `docker exec` выполняются
  внутри этого контейнера с тем же ограничением.
- Устройство берётся из `MYRMIDON_PREDEPLOY_IO_DEVICE`, а без него определяется
  по DockerRootDir через `findmnt`; если устройство определить нельзя, проверка
  завершается до запуска копии.
- Dry-run показывает устройство и лимиты, тест fake-Docker проверяет оба флага.
