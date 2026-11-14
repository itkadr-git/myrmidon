## changelog-en

### Fixed: remote runner workspace upload no longer fails with "ssh exited before tar finished" (OPE-13041)

- The workspace upload to a remote runner (`syncDirectoryToSsh`, `packages/adapter-utils/src/ssh.ts`) piped local `tar` into `ssh`. When `ssh` closed with exit code 0 a moment before the local `tar` reported its exit, the transfer was stopped and reported as `ssh exited before tar finished (code 0)`, which failed the whole run although all data had been delivered.
- The outcome is now decided by the exit codes of both processes. After `ssh` exits with code 0 the upload waits for `tar` (up to 10 s) and succeeds when `tar` exits with 0. A failing `tar` is reported with its stderr tail, a failing `ssh` with its own stderr tail or exit code. The transfer protocol and directory layout are unchanged.
- Covered by `packages/adapter-utils/src/ssh-tar-finish-order.myrmidon.test.ts`.

## changelog-ru

### Исправлено: выгрузка рабочего каталога на удалённый раннер больше не падает с «ssh exited before tar finished» (OPE-13041)

- Выгрузка каталога на удалённый раннер (`syncDirectoryToSsh`, `packages/adapter-utils/src/ssh.ts`) передаёт локальный `tar` в `ssh`. Если `ssh` закрывался с кодом 0 чуть раньше, чем локальный `tar` сообщал о завершении, передача прерывалась и считалась сбоем `ssh exited before tar finished (code 0)`, и весь прогон падал, хотя данные были доставлены.
- Итог теперь определяется кодами выхода обоих процессов. После выхода `ssh` с кодом 0 выгрузка ждёт `tar` (до 10 с) и считается успешной при коде 0 у `tar`. Сбой `tar` сообщается с хвостом его stderr, сбой `ssh` — с его stderr или кодом выхода. Протокол передачи и раскладка каталогов не менялись.
- Покрыто тестом `packages/adapter-utils/src/ssh-tar-finish-order.myrmidon.test.ts`.
