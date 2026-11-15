## changelog-en

### Variables introduced by Myrmidon are named MYRMIDON_* (REBRAND-OWN-ENV, OPE-12652)

- The omp adapter reads `MYRMIDON_OMP_PROVIDERS` and `MYRMIDON_OMP_COMMAND`. The names it shipped with, `PAPERCLIP_OMP_PROVIDERS` and `PAPERCLIP_OMP_COMMAND`, still work for one release as deprecated aliases; a run that uses the old provider name says so in its first note.
- Other variables we had introduced under the vendor prefix are renamed the same way, with the old name kept as an alias:
  - `MYRMIDON_RUNNER_SANDBOX_COMMAND`;
  - `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` (the bot runtime sets both names);
  - `MYRMIDON_GIT_PROBE_ACTIVE`;
  - `MYRMIDON_PARENT_BOOT_ID`;
  - the dev launcher's `MYRMIDON_PROCESS_MODE` / `MYRMIDON_PROCESS_ROLE`;
  - the standby drill's `MYRMIDON_DB_PASSWORD`;
  - the scripts' `MYRMIDON_BASE_URL` and `MYRMIDON_UPSTREAM_REPO`.
- The omp discovery cache now ignores per-run `MYRMIDON_*` variables, as it already ignored `PAPERCLIP_*` ones.
- New CI guard `scripts/myrmidon/ci/paperclip-names-ratchet.mjs`, run by the checks job's script tests. It fails a change that adds a `PAPERCLIP_*` name absent from `scripts/myrmidon/ci/paperclip-names-baseline.txt`, which lists the vendor names and our deprecated aliases.

## changelog-ru

### Переменные, введённые Myrmidon, называются MYRMIDON_* (REBRAND-OWN-ENV, OPE-12652)

- Адаптер omp читает `MYRMIDON_OMP_PROVIDERS` и `MYRMIDON_OMP_COMMAND`. Прежние имена `PAPERCLIP_OMP_PROVIDERS` и `PAPERCLIP_OMP_COMMAND` работают ещё один выпуск как устаревшие синонимы. Если прогон взял провайдеров по старому имени, он сообщает об этом в первой заметке.
- Так же переименованы другие наши переменные со старым префиксом. Старое имя оставлено синонимом:
  - `MYRMIDON_RUNNER_SANDBOX_COMMAND`;
  - `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` (среда бота задаёт оба имени);
  - `MYRMIDON_GIT_PROBE_ACTIVE`;
  - `MYRMIDON_PARENT_BOOT_ID`;
  - `MYRMIDON_PROCESS_MODE` и `MYRMIDON_PROCESS_ROLE` dev-лончера;
  - `MYRMIDON_DB_PASSWORD` учений резерва;
  - `MYRMIDON_BASE_URL` и `MYRMIDON_UPSTREAM_REPO` скриптов.
- Кэш обнаружения моделей omp не учитывает переменные прогона `MYRMIDON_*`, как уже не учитывал `PAPERCLIP_*`.
- Новый сторож CI `scripts/myrmidon/ci/paperclip-names-ratchet.mjs` запускается среди тестов скриптов в задании checks. Он не пропускает изменение, которое добавляет имя `PAPERCLIP_*`, отсутствующее в `scripts/myrmidon/ci/paperclip-names-baseline.txt`. В этом списке — имена вендора и наши устаревшие синонимы.

## settings-en-append

<!-- section: Name mapping PAPERCLIP_* → MYRMIDON_* -->
| `PAPERCLIP_OMP_PROVIDERS` | `MYRMIDON_OMP_PROVIDERS` |
| `PAPERCLIP_OMP_COMMAND` | `MYRMIDON_OMP_COMMAND` |
| `PAPERCLIP_RUNNER_SANDBOX_COMMAND` | `MYRMIDON_RUNNER_SANDBOX_COMMAND` |
| `PAPERCLIP_GITHUB_CREDENTIALS_CACHE_DIR` | `MYRMIDON_GITHUB_CREDENTIALS_CACHE_DIR` |
| `PAPERCLIP_GIT_PROBE_ACTIVE` | `MYRMIDON_GIT_PROBE_ACTIVE` |
| `PAPERCLIP_PARENT_BOOT_ID` | `MYRMIDON_PARENT_BOOT_ID` |
| `PAPERCLIP_PROCESS_MODE` | `MYRMIDON_PROCESS_MODE` |
| `PAPERCLIP_PROCESS_ROLE` | `MYRMIDON_PROCESS_ROLE` |
| `PAPERCLIP_DB_PASSWORD` | `MYRMIDON_DB_PASSWORD` |
| `PAPERCLIP_BASE_URL` | `MYRMIDON_BASE_URL` |
| `PAPERCLIP_UPSTREAM_REPO` | `MYRMIDON_UPSTREAM_REPO` |
