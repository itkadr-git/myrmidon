---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Deploy precheck counts incoming release images and DB dump reserve (OPE-7723)

- `deploy_disk_precheck` now adds the registry size of every release image that
  is not present locally (resolved through the linux/amd64 platform manifest of
  an OCI image index) to the required free space before pulling anything or
  entering the maintenance window; a deploy that cannot fit is refused before
  the first pull with cleanup candidates printed.
- New setting `MYRMIDON_DEPLOY_DB_DUMP_RESERVE_GB` (default 5) reserves space
  for the predeploy database copy. The reserve applies only to full deploys
  that declare `MYRMIDON_DEPLOY_IMAGE_REFS`; `bot-image-rollout.sh` and
  `rollout-component.sh` keep the plain `MYRMIDON_DEPLOY_MIN_FREE_GB` threshold.
- The precheck fails closed when an image size cannot be determined from the
  registry; in `--dry-run` it warns and continues instead (a dry run refuses
  nothing).
- Unknown free space on `/var/lib/docker` continues a dry run with a warning;
  a real deploy is still refused.

## changelog-ru

### Предпроверка выката учитывает объём скачиваемых образов и резерв дампа БД (OPE-7723)

- `deploy_disk_precheck` добавляет к требуемому месту размер каждого образа
  релиза, которого нет локально (манифест платформы linux/amd64 из OCI index),
  до скачивания и до окна обслуживания; выкат, которому не хватит места,
  останавливается до первого pull с перечнем кандидатов на очистку.
- Новая переменная `MYRMIDON_DEPLOY_DB_DUMP_RESERVE_GB` (по умолчанию 5)
  резервирует место под копию БД. Резерв применяется только к полным выкатам
  с заданным `MYRMIDON_DEPLOY_IMAGE_REFS`; `bot-image-rollout.sh` и
  `rollout-component.sh` сохраняют прежний порог `MYRMIDON_DEPLOY_MIN_FREE_GB`.
- Предпроверка отказывает в выкате, если размер образа нельзя определить из
  registry; в `--dry-run` вместо отказа предупреждение и продолжение (dry-run
  ничего не отклоняет).
- Неизвестное свободное место на `/var/lib/docker` в dry-run даёт предупреждение
  и продолжение; боевой выкат по-прежнему прекращается.
