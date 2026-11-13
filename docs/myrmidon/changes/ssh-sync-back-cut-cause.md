## changelog-en

### Fixed: a cut ssh stream during workspace download is reported by its cause (SSH-SYNC-CUT-CAUSE)

- When the stream of the workspace download from a remote runner (`syncDirectoryFromSsh`, `packages/adapter-utils/src/ssh.ts`) was cut, both `ssh` and the extracting `tar` failed, and the reported error depended on whose `close` event came first: sometimes the cause (`Connection reset by peer`), sometimes only the effect (`tar: Unexpected EOF in archive`).
- After the extracting `tar` fails, `ssh` now gets up to 1.5 s to end on its own; its own error is reported when it fails. Only an `ssh` still running after that is stopped, and `tar`'s error is reported as before (disk full, signal 15 from the stop).
- Covered by `packages/adapter-utils/src/ssh-sync-back-cleanup.myrmidon.test.ts` (both close orders).

## changelog-ru

### Исправлено: обрыв потока ssh при скачивании рабочего каталога сообщается по причине (SSH-SYNC-CUT-CAUSE)

- При обрыве потока скачивания каталога с удалённого раннера (`syncDirectoryFromSsh`, `packages/adapter-utils/src/ssh.ts`) падали и `ssh`, и распаковывающий `tar`, а в ошибку попадала та причина, чей `close` пришёл первым: то причина (`Connection reset by peer`), то лишь следствие (`tar: Unexpected EOF in archive`).
- После сбоя распаковывающего `tar` `ssh` теперь получает до 1,5 с завершиться сам; если он упал, сообщается его ошибка. Остановка и ошибка `tar` — только если `ssh` всё ещё работает (диск заполнен, сигнал 15 от остановки), как и раньше.
- Покрыто `packages/adapter-utils/src/ssh-sync-back-cleanup.myrmidon.test.ts` (оба порядка завершения).
