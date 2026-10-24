<!-- bot/OPE-7653 — 1.6.6 C-MEM: canonical compose of the site memory -->

## changelog-en

### Site memory has a canonical compose (1.6.6)

- `docker/site-memory/docker-compose.yml` defines `hs-pg` (pgvector) and `hindsight-work` as one
  managed service of an execution site: loopback port only, digest-pinned images through
  variables with no default, limits on memory and pids, secrets only in profile files
  next to the compose. Operator guide section 4.5 (EN and RU) describes the bring-up, the fleetd
  `memory` settings and the nightly sync with its journal.
- The degradation scenario is covered by a test: with the link down for five minutes the site's
  bots recall and retain locally, the board's hindsight is not asked, and after the link returns
  the replica catches up without a duplicate document, also after an import that broke off.

## changelog-ru

### У памяти площадки есть каноническая схема compose (1.6.6)

- `docker/site-memory/docker-compose.yml` описывает `hs-pg` (pgvector) и `hindsight-work` как один
  управляемый сервис площадки исполнения: только loopback-порт, образы по digest через
  переменные без значения по умолчанию, лимиты памяти и процессов, секреты только в файлах
  профиля рядом с compose. Раздел 4.5 инструкции оператора (EN и RU) описывает запуск,
  настройку `memory` в fleetd и ночную синхронизацию с журналом.
- Сценарий деградации покрыт тестом: пока связь пять минут не работает, боты площадки вспоминают
  и записывают локально, hindsight доски не опрашивается, а после восстановления реплика
  догоняет без дублей документов, в том числе после оборвавшегося импорта.
