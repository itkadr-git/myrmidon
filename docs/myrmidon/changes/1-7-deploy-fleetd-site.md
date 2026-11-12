## changelog-en

### Deploy rolls fleetd out to remote sites as a systemd binary (OPE-12880)

- `MYR_<COMPONENT>_HOST` gained the `site:<user>@<host>` mode: the component is
  a systemd binary on a remote site host (the 1.7 fleetd pattern — no compose
  project there). The rollout extracts the binary from the release image on the
  deploy host, streams it over ssh, and the site installs it with a
  `.pre-deploy` backup, restarts the unit and requires it `active`; on any
  failure the site restores its own backup, so a failed rollout never leaves
  the site down.
- Site settings: `MYR_<COMPONENT>_SITE_SERVICE` (default `myrmidon-<component>`),
  `MYR_<COMPONENT>_SITE_BINARY` (default `/usr/local/bin/<component>`),
  `MYR_<COMPONENT>_SITE_HEALTH_URL` (REQUIRED — the deploy host must reach the
  site's health endpoint; for fleetd that is the mTLS `/v1/health`, pass the
  cert arguments in the same value as any health URL). The unit must already
  exist on the site; a rollout onto a host that never ran the service is
  refused (fail-closed, the 1.4.0 pattern).
- `rollback-component.sh` targets the same site by restoring the site's OWN
  backup (`<binary>.pre-deploy`, made by the last activation on the site),
  restarting the unit and proving the same health URL. `--to-image` stays a
  compose-mode option: a digest identifies a binary only through an image ref,
  and a site has no image.
- The one-deploy view of a site is the sha256 of its binary, so deploy.sh
  reports `site:<digest>` in the component plan and skips the restart when the
  site already runs the release binary. The automatic all-or-nothing rollback
  rolls a failed site component back through that same backup.

## changelog-ru

### Деплой выкатывает fleetd на удалённые площадки как systemd-бинарник (OPE-12880)

- У `MYR_<COMPONENT>_HOST` появился режим `site:<user>@<host>`: компонент —
  это systemd-бинарник на удалённой площадке (паттерн fleetd 1.7 — без
  compose-проекта). Rollout извлекает бинарник из release-образа на
  deploy-хосте, передаёт его по ssh, а площадка устанавливает его с бэкапом
  `.pre-deploy`, перезапускает юнит и требует статус `active`; при любой
  ошибке площадка сама восстанавливает свой бэкап — неудачный выкат не
  оставляет площадку лежащей.
- Настройки площадки: `MYR_<COMPONENT>_SITE_SERVICE` (по умолчанию
  `myrmidon-<component>`), `MYR_<COMPONENT>_SITE_BINARY` (по умолчанию
  `/usr/local/bin/<component>`), `MYR_<COMPONENT>_SITE_HEALTH_URL`
  (обязателен — deploy-хост должен доставать health-эндпоинт площадки; для
  fleetd это mTLS `/v1/health`, аргументы сертификатов передаются в том же
  значении, как у любого health URL). Юнит должен уже существовать на
  площадке; выкат на хост, где служба никогда не работала, отвергается
  (fail-closed, паттерн 1.4.0).
- `rollback-component.sh` целился в ту же площадку через восстановление
  СОБСТВЕННОГО бэкапа площадки (`<binary>.pre-deploy`, его делает последняя
  активация на самой площадке), с перезапуском юнита и проверкой того же
  health URL. `--to-image` остаётся опцией compose-режима: digest опознаёт
  бинарник только через образ, а у площадки образа нет.
- Для one-deploy площадка видна как sha256 её бинарника: deploy.sh печатает
  `site:<digest>` в плане компонентов и не перезапускает площадку, где уже
  работает бинарник релиза. Автоматический откат «всё или ничего» возвращает
  упавший компонент площадки к тому же бэкапу.
