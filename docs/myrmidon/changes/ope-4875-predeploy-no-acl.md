---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Predeploy database check restores the dump with --no-owner --no-acl by default (1.6.5 PREDEPLOY-NO-ACL)

- The default restore command of the predeploy database check
  (`predeploy-board-check.sh`, `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`) now
  carries `--no-acl` next to the existing `--no-owner`. The production dump
  contains GRANTs to roles that exist only on the production server (e.g.
  `backup_ro`); the throwaway Postgres of the check does not have them and
  `pg_restore` aborted with `role "backup_ro" does not exist`, so the check
  died on the restore step of every such dump before the board was ever
  started (OPE-4875, vm-core 06.10).
- The check proves the board reads the production DATA on the copy, not the
  production grants model, so skipping ownership and ACL statements is the
  correct default. An operator who wants the grants modelled on the copy
  pre-creates the roles and overrides `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`;
  the override is still used exactly as given.
- `scripts/myrmidon/deploy/deploy.env.example` documents the new default and
  the reason; the script test suite now models a dump with a GRANT to a
  missing role and proves the old command aborts on it while the new default
  restores.

## changelog-ru

### Проверка копии БД перед выкатом восстанавливает дамп по умолчанию с --no-owner --no-acl (1.6.5 PREDEPLOY-NO-ACL)

- Штатная команда восстановления проверки копии БД перед выкатом
  (`predeploy-board-check.sh`, `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`) теперь
  содержит `--no-acl` рядом с прежним `--no-owner`. Дамп боевой базы содержит
  GRANT ролям, которые существуют только на боевом сервере (например
  `backup_ro`); в одноразовом Postgres проверки их нет, и `pg_restore` падал
  с `role "backup_ro" does not exist` — проверка умирала на шаге
  восстановления такого дампа, не успев запустить доску (OPE-4875, vm-core
  06.10).
- Проверка доказывает, что доска читает боевые ДАННЫЕ на копии, а не боевую
  модель прав, поэтому пропуск владельца и ACL — корректное поведение по
  умолчанию. Оператор, которому нужна модель прав на копии, заранее создаёт
  роли и задаёт `MYRMIDON_PREDEPLOY_RESTORE_COMMAND`; переопределение по-
  прежнему выполняется ровно как задано.
- `scripts/myrmidon/deploy/deploy.env.example` документирует новое значение по
  умолчанию и причину; тест сюиты скрипта теперь моделирует дамп с GRANT на
  отсутствующую роль и доказывает, что старая команда на нём падает, а новая
  штатная — восстанавливает.

## divergence

| 1.6.5-PREDEPLOY-NO-ACL | Штатная команда восстановления дампа в проверке копии БД перед выкатом (`predeploy-board-check.sh`) получила `--no-acl` в дополнение к `--no-owner`: GRANT на боевые роли (`backup_ro` и т.п.), отсутствующие в одноразовом Postgres, больше не роняют pg_restore (OPE-4875). Переопределение `MYRMIDON_PREDEPLOY_RESTORE_COMMAND` по-прежнему выполняется как задано | `scripts/myrmidon/deploy/predeploy-board-check.sh` (помечено `myrmidon(PREDEPLOY-NO-ACL)`), тест `scripts/myrmidon/deploy/predeploy-board-check.test.mjs`, `scripts/myrmidon/deploy/deploy.env.example` | Боевой дамп содержит права ролей, которых нет в одноразовом Postgres — проверка падала до запуска доски; проверка доказывает чтение данных, а не модель прав | `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` (тесты «dump with GRANTs to production-only roles» и «old default fails») | Никогда, наше поведение: при необходимости боевые права моделируются на копии переопределением `MYRMIDON_PREDEPLOY_RESTORE_COMMAND` с предсозданными ролями | (этот PR) |
