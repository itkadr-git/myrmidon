## changelog-en

### Apply wipes the vendor's config backups out of hermes volumes (HERMES-CONFIG-BACKUP-SECRETS)

- The vendored Hermes CLI snapshots `config.yaml` into `hermes/backups/config/` on
  every successful config load and offers no switch to disable it, so those copies
  (which can carry the gateway credential once the CLI resolves it) reached host
  backups. The generated profile apply script now removes `data/hermes/backups` as
  a best-effort step after the staged files land and before the applied-state
  marker, so a leak is cleaned up on the next profile rebuild of every bot and an
  `rm` failure can never abort the apply.
- The dockergate gate's embedded apply-script template and contract fixtures carry
  the same step; tests pin the cleanup's presence and its order relative to the
  marker, and that the compiler never writes a secret value into `config.yaml`
  (only a `${VAR}` reference; the key lives in `hermes/.env`, mode 0600).


## changelog-ru

### Apply вычищает вендорские бэкапы конфига из томов hermes (HERMES-CONFIG-BACKUP-SECRETS)

- Вендорский CLI Hermes сохраняет снимок `config.yaml` в `hermes/backups/config/`
  при каждой успешной загрузке конфига и не предоставляет переключателя для отключения,
  поэтому эти копии (способные содержать учётные данные шлюза после их разрезания CLI)
  попадали в резервные копии хоста. Генерируемый apply-скрипт применения профиля теперь
  удаляет `data/hermes/backups` best-effort шагом — после переноса staged-файлов и до
  маркера состояния применения; утечка вычищается при первой пересборке профиля каждого
  бота, а сбой `rm` не может прервать apply.
- Встроенный шаблон apply-скрипта гейта dockergate и контрактные фикстуры содержат тот же
  шаг; тесты фиксируют наличие очистки и её порядок относительно маркера, а также то, что
  компилятор никогда не пишет значение секрета в `config.yaml` — только ссылку `${VAR}`;
  ключ лежит в `hermes/.env`, режим 0600.

