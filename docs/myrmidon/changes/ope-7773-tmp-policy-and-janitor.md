---
divergence-section: Инфраструктура
---

## changelog-en

### /tmp hygiene policy and host janitor for temporary profiles (OPE-7773)

- Routed agent Chromium browser profiles into a run-scoped scratch directory (`$PAPERCLIP_SCRATCH_DIR/run-dir`), cleaned up automatically upon heartbeat run termination.
- Added automated trap cleanup for `install.sh` temporary release manifests and registered test sandbox cleanup in `install.test.mjs`.
- Introduced host-level `tmp-janitor.sh` with systemd service and timer units to prune orphaned `chr-*`, `native-*`, `mdep-*`, and `myrmidon-install-test-*` directories older than TTL with positive integer validation, recursive open-file activity detection (`lsof` and `/proc`), fail-closed safety, and protection for live profiles (e.g., `claude-1002`).
- Documented `/tmp` `size=8G` tmpfs fstab configuration to prevent unbounded host memory usage.

## changelog-ru

### Политика /tmp и хостовый janitor временных профилей (OPE-7773)

- Профили Chromium browser-агентов вынесены в run-scoped каталог (`$PAPERCLIP_SCRATCH_DIR/run-dir`), автоматически удаляемый при завершении прогона.
- В `install.sh` добавлен trap-клининг временного манифеста релиза, а в `install.test.mjs` настроена зачистка тестовых сэндбоксов через `afterEach`.
- Добавлен хостовый скрипт `tmp-janitor.sh` с systemd-сервисом и таймером для ежечасной очистки `chr-*`, `native-*`, `mdep-*` и `myrmidon-install-test-*` по строгому валидируемому TTL, с рекурсивным определением открытых файлов (`lsof` / `/proc`), безопасным fail-closed поведением и защитой живых профилей (`claude-1002`).
- Добавлена документация и рекомендация по ограничению размера mount `/tmp` (`size=8G`) в fstab.
