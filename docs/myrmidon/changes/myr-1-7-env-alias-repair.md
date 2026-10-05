---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### REBRAND-C env alias: codemod repair after main merge (OPE-4561)

- The REBRAND-C codemod had rewritten `delete process.env.X` into
  `delete readProductEnv(From)(...)` in the hermes adapter, the CLI onboard
  command and the native-session executor — a no-op at runtime that left the
  variable in the child environment and stopped type-checking after the main
  merge. Removal now goes through `deleteProductEnv`, dropping both the
  `MYRMIDON_*` and the legacy `PAPERCLIP_*` spelling.
- Call sites that used the `readProductEnv(From)` result as a guaranteed
  string (opencode-local / pi-local command override, server config path,
  agent-assigned-tools API base URL, startup-banner JWT file check) now bind
  the value once and narrow `undefined` explicitly.
- A stray commit `7b22807f` (Telegram `/accept` `/reject` commands, not part
  of this PR) and the OPE-4131 heartbeat list-perf edits it had pasted into
  `server/src/services/heartbeat.ts` were removed by a revert commit.

## changelog-ru

### REBRAND-C env alias: ремонт codemod после слияния main (OPE-4561)

- Codemod REBRAND-C переписал `delete process.env.X` в
  `delete readProductEnv(From)(...)` в адаптере hermes, команде onboard CLI и
  native-session-executor — no-op в рантайме, оставлявший переменную в
  окружении дочернего процесса и ломавший tsc после слияния main. Удаление
  теперь идёт через `deleteProductEnv`, снимающий и написание `MYRMIDON_*`,
  и старый алиас `PAPERCLIP_*`.
- Места, где результат `readProductEnv(From)` использовался как гарантированная
  строка (переопределение команды opencode-local / pi-local, путь конфига
  сервера, API base URL в agent-assigned-tools, проверка JWT из файла в
  startup-banner), теперь связывают значение один раз и явно сужают
  `undefined`.
- Посторонний коммит `7b22807f` (Telegram-команды `/accept` `/reject`, не из
  этого PR) и вклеенные им правки OPE-4131 по производительности списка
  heartbeat-прогонов в `server/src/services/heartbeat.ts` убраны откатным
  коммитом.

## divergence

| REBRAND-C-REPAIR | Ремонт codemod env-алиаса после слияния main: удаление переменных через `deleteProductEnv` (оба написания), сужение `string \| undefined` у `readProductEnv(From)`, откат постороннего коммита /accept /reject | Те же файлы, что трогал REBRAND-C; `deleteProductEnv` уже был в `packages/shared/src/env-alias.ts` | Codemod оставил невалидный `delete` результата функции и необработанный `undefined` | tsc server чистый; vitest shared env-alias 11/11; adapters 96 passed / 48 skipped; `check-forbidden-tokens` чистый | Никогда, ремонт нашего codemod | (этот PR) |
