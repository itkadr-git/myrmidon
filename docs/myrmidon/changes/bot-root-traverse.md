## changelog-en

### The driver normalizes the bot root's traversal at apply; a blocked /bot fails with its own error (BOT-ROOT-TRAVERSE)

- After the single-mount rollout (myrmidon #572, rc.1) a bot mounts its whole
  host directory `<volumeRoot>/<botKey>` at `/bot`, but the prepare helper only
  ever chmod'd/chown'd the three subdirectories behind it. A root left by an
  external operation as `root:65532 0710` (51 of 74 production bots — no code
  in this repository sets 0710; it predates the deploy scripts now in the
  private deploy repo) hides everything under `/bot` from the bot's uid 10001,
  and the entrypoint surfaced that as a misleading "API_SERVER_KEY is required".
  Production was hand-fixed to 0711 on 05.10; this is the product fix.
- `server/src/myrmidon/bot-containers/docker-driver.ts` +
  `template.ts` (mirrored byte-for-byte in
  `tools/dockergate/internal/policy/scripts.go` and the contract fixtures):
  the prepare helper now also binds the bot's root itself (the same
  `<volumeRoot>/<botKey>:/bot` bind string the bot container carries) and its
  script ends with one non-recursive `chmod 0711 bot` — the bot's uid can enter
  `/bot` (x) without browsing it (no r), the owner stays root (the gate's
  volume.K invariant), the content is never listed, written or chowned, and the
  text stays a constant with no recursion, find, glob or links (RT1-2).
  Idempotent: any external 0710/0700 stops being fatal at the next apply.
  The shared-scope layout needs no extra line: its tree root IS the instance
  directory the script already chmods 0700 and chowns to uid 10001.
- `tools/dockergate/internal/policy/create.go`: the isolated prepare helper
  accepts exactly the four binds (three narrow + the `/bot` root); everything
  else stays a `binds_mismatch` denial. `volume.go` documents why the gate
  deliberately does not require bot traversal of `volumeRoot/K`: the incident
  mode 0710 must pass the gate so that the prepare helper can reach and fix it.
- `docker/bot-runtime/entrypoint.sh`: when the isolated bot root exists but is
  not executable by the bot's uid, it fails in one line naming the traversal
  problem and the fix (recreate the bot) instead of falling through to the
  API-key error. Tests: `scripts/myrmidon/bot-containers/prepare-root-traverse.test.mjs`,
  `scripts/myrmidon/bot-runtime/entrypoint.test.mjs`, driver/scope/gate unit tests.

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
