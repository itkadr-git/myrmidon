## changelog-en

### `myr-ws close` and `myr-ws restore` share one archive root (1.6.5 BOT-DISK-H)

- `close` called the archive module without a root, so the archive went to the
  module's production default while `restore` looked under
  `<MYRMIDON_WS_HOME>/archive`: with `MYRMIDON_WS_HOME` overridden a closed
  copy could not be restored. The root is now one function of the home
  (`archiveRootOf` in the `myr-ws` layout); `close` passes it to the archive and
  `restore` reads it. With the default home nothing changes.

## changelog-ru

### `myr-ws close` и `myr-ws restore` используют один корень архива (1.6.5 BOT-DISK-H)

- `close` вызывал модуль архива без корня, и архив уходил в боевой путь по
  умолчанию самого модуля, а `restore` искал в `<MYRMIDON_WS_HOME>/archive`:
  при переопределённом `MYRMIDON_WS_HOME` закрытую копию нельзя было
  восстановить. Теперь корень — одна функция от home (`archiveRootOf` в
  раскладке `myr-ws`): `close` передаёт его архиву, `restore` читает из него.
  При home по умолчанию поведение не меняется.
