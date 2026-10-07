---
settings-section: Track 5 — operations
---

## changelog-en

### Deploy hardening: a deploy that fails early and says why (DEPLOY-HARDENING)

- **One source of truth per component image.** The generated override file of each local
  release component is what the deploy writes, the rollback restores and the boot unit reads
  (the canonical unit lists the component overrides; `SYSTEMD_UNIT_INSTALL=1` replaces the unit
  of the previous release, a foreign unit is still refused). The "previous" image is the image of
  the running container (`docker inspect`), not a file; a stale override is corrected to the image
  that runs before the deploy starts. The compose project of every component check includes the
  board image override, so a valid project is no longer reported as "not a service", and an
  invalid one is reported with compose's own error text.
- **`--dry-run` runs the real preflight.** Before the first pull and the dump, in a dry run and a
  real run alike: the compose project, the CI image checks, the boot unit, every component's service
  and health setting, the dockergate config check of the edited config (by the new binary, as its
  own user, on a copy keeping the file's owner and mode). The dry run fails
  exactly when the real run would.
- **dockergate health without a ping the host cannot make.** dockergate's socket answers only the
  board's main process, so the documented `_ping` probe from the host could never pass. dockergate is
  now proven by its log: the container runs and its newest `self-check ok` / `config_reloaded` line
  reports the new version and the hash of its config. dockergate logs `configHash` on both lines.
  `MYR_DOCKERGATE_HEALTH_URL` is no longer used. The rollback uses the same proof.
- **Config writes keep owner and mode, and a reload is verified.** Edits of the dockergate config,
  the fleetd config and the override files keep the owner and mode of the file they replace (a strict
  `umask` no longer turns the config into `0600 root`, which dockergate's user could not read); after
  SIGHUP the deploy checks that dockergate loaded the new config hash and fails loudly otherwise.
  The output of `dockergate check-config` is logged when it refuses.

## changelog-ru

### Усиление выката: выкат падает рано и объясняет почему (DEPLOY-HARDENING)

- **Один источник правды на образ компонента.** Сгенерированный override каждого локального
  компонента релиза — то, что пишет выкат, что восстанавливает откат и что читает загрузочный юнит
  (канонический юнит перечисляет override компонентов; `SYSTEMD_UNIT_INSTALL=1` заменяет юнит
  предыдущего релиза, чужой юнит по-прежнему отказ). «Предыдущий» образ — образ работающего
  контейнера (`docker inspect`), а не файл; устаревший override исправляется до образа, который
  работает, ещё до начала выката. Compose-проект в каждой проверке компонента включает override
  образа доски, поэтому валидный проект больше не называется «не сервис», а невалидный
  сообщается дословным текстом ошибки compose.
- **`--dry-run` выполняет настоящий предполёт.** До первого pull и дампа — и в сухом, и в настоящем
  прогоне: compose-проект, проверки CI-образов, загрузочный юнит, сервис и настройка health каждого
  компонента, проверка конфига dockergate (отредактированного, новым бинарём, от его пользователя,
  на копии с владельцем и правами файла). Сухой прогон падает ровно тогда, когда
  упал бы настоящий.
- **Здоровье dockergate без пинга, который хост сделать не может.** Сокет dockergate отвечает
  только главному процессу доски, поэтому документированная проба `_ping` с хоста не могла пройти.
  Теперь dockergate доказывается журналом: контейнер работает, а свежая строка `self-check ok` /
  `config_reloaded` называет новую версию и хеш конфига. dockergate пишет `configHash` в обе строки.
  `MYR_DOCKERGATE_HEALTH_URL` больше не используется. Откат использует то же доказательство.
- **Запись конфигов сохраняет владельца и права, перезагрузка проверяется.** Правки конфига
  dockergate, конфига fleetd и override-файлов сохраняют владельца и права заменяемого файла
  (строгий `umask` больше не делает конфиг `0600 root`, который пользователь dockergate не мог
  прочитать); после SIGHUP выкат проверяет, что dockergate загрузил новый хеш конфига, и иначе
  падает громко. Вывод `dockergate check-config` пишется в журнал при отказе.

## settings-en

| `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_RELOAD_TIMEOUT_SEC` | DEPLOY-HARDENING | `30` | After the SIGHUP the deploy waits this long for dockergate to log the hash of the new config (`config_reloaded`); otherwise it fails loudly (the old config is still in memory) | A larger value for a slow host; the check itself cannot be turned off |
| `MYR_DOCKERGATE_HEALTH_URL` | DEPLOY-HARDENING | unused | No longer read: the host cannot ping dockergate (its socket answers only the board's main process, `403 caller_not_board_main`). dockergate is proven by its log (running container, newest `self-check ok` / `config_reloaded` line with the new version and config hash); `DOCKERGATE_LOGS_COMMAND` names the log when dockergate is not a compose service of the host. Supersedes the earlier `MYR_DOCKERGATE_HEALTH_URL` row | — |

## settings-ru

| `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_RELOAD_TIMEOUT_SEC` | DEPLOY-HARDENING | `30` | После SIGHUP выкат ждёт столько, пока dockergate запишет в журнал хеш нового конфига (`config_reloaded`); иначе падает громко (старый конфиг ещё в памяти) | Больше — для медленного хоста; саму проверку выключить нельзя |
| `MYR_DOCKERGATE_HEALTH_URL` | DEPLOY-HARDENING | не используется | Больше не читается: хост не может «пингануть» dockergate (его сокет отвечает только главному процессу доски, `403 caller_not_board_main`). dockergate доказывается журналом (контейнер работает, свежая строка `self-check ok` / `config_reloaded` с новой версией и хешем конфига); `DOCKERGATE_LOGS_COMMAND` называет журнал, если dockergate не compose-сервис хоста. Заменяет прежнюю строку `MYR_DOCKERGATE_HEALTH_URL` | — |
