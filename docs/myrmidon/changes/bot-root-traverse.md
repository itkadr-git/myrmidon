## changelog-en
### The driver normalizes the bot root's traversal at apply; a blocked /bot fails with its own error (BOT-ROOT-TRAVERSE)

- A bot mounts `<volumeRoot>/<botKey>` at `/bot`, but the prepare helper only
  fixed the three subdirectories behind it: a root left `0710` by an external
  operation (51 of 74 production bots) hid `/bot` from the bot's uid 10001 and
  surfaced as a misleading "API_SERVER_KEY is required".
- The prepare helper (driver, template, dockergate mirror, contract fixtures)
  now also binds the bot root and ends with one non-recursive `chmod 0711` —
  the bot can enter `/bot` without browsing it; idempotent, no recursion or
  globs. The shared-scope layout needs no extra line.
- dockergate's isolated helper accepts exactly the four binds; the gate
  deliberately lets mode `0710` pass so the helper can reach and fix it.
- entrypoint.sh: an unexecutable bot root fails in one line naming the
  problem (recreate the bot) instead of falling through to the API-key error.
  Tests: prepare-root-traverse, entrypoint, driver/scope/gate units.
## changelog-ru

### Драйвер нормализует проход в корень бота при применении; недоступный /bot падает своей ошибкой (BOT-ROOT-TRAVERSE)

- После перехода на один том (myrmidon #572, rc.1) бот монтирует весь свой
  каталог `<volumeRoot>/<botKey>` как `/bot`, но prepare-хелпер трогал только
  три подкаталога внутри него. Корень, оставленный внешними операциями как
  `root:65532 0710` (51 из 74 боевых ботов; кода, ставящего 0710, в этом
  репозитории нет — это след установочных скриптов приватного deploy-репо),
  закрывал всё под `/bot` от uid 10001, и entrypoint падал с вводящей в заблуждение
  ошибкой «API_SERVER_KEY is required». На бою 05.10 исправлено вручную (0711);
  это фикс в продукте.
- `docker-driver.ts` + `template.ts` (байт-в-байт продублированы в
  `tools/dockergate/internal/policy/scripts.go` и контрактных фикстурах):
  prepare-хелпер теперь получает и сам корень (тот же bind
  `<volumeRoot>/<botKey>:/bot`, что у контейнера бота), и его скрипт заканчивается
  одним нерекурсивным `chmod 0711 bot` — uid 10001 входит в `/bot` (x), но не
  читает список (нет r), владелец остаётся root (инвариант gate'а volume.K),
  содержимое не читается, не пишется и не перечопринится; текст остаётся
  константой без рекурсии, find, glob и симлинков (RT1-2). Идемпотентно: любое
  внешнее 0710/0700 перестаёт быть фатальным после ближайшего применения.
  Shared-компоновке отдельная строка не нужна: корень дерева членов — каталог
  инстанса, который скрипт и так делает 0700 + chown 10001.
- `tools/dockergate/internal/policy/create.go`: изолированный prepare-хелпер
  принимает ровно четыре bind'а (три узких + корень `/bot`); всё остальное —
  по-прежнему `binds_mismatch`. `volume.go` документирует, почему gate намеренно
  не требует прохода бота в `volumeRoot/K`: инцидентный режим 0710 должен
  проходить gate, чтобы prepare-хелпер мог до него достать и починить.
- `docker/bot-runtime/entrypoint.sh`: если корень изолированного бота существует,
  но недоступен для входа uid бота, падает одной строкой с явной причиной
  (права корня каталога бота) и указанием починить пересозданием бота, а не
  ошибкой API-ключа. Тесты: `prepare-root-traverse.test.mjs`,
  `entrypoint.test.mjs`, юнит-тесты драйвера/скоупа/гейта.
