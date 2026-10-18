## changelog-en

### Access hub: ssh failure notes no longer echo command details (SEC1)

A failed ssh operation of the Access hub (deploy/revoke/dry-run of a key on
a fleet host) now reports only `ssh command timed out` or
`ssh command failed (exit <code>)` in the API response and the journal —
never the host address, the login, the admin key file path or the remote
command. Deploy and dry-run of a secret whose stored public key half is
missing or unparseable now refuse up front with `not_deployed` and the note
`the secret has no parseable public key half` instead of writing a useless
`authorized_keys` line that reported `deployed`. The ssh operations contract
is documented in the Access hub guide.

## changelog-ru

### Хаб доступов: заметки об ошибках ssh больше не раскрывают детали команды (SEC1)

Упавшая ssh-операция хаба доступов (раскладка, отзыв, dry-run ключа на хосте
парка) теперь сообщает в ответе API и в журнале только `ssh command timed
out` или `ssh command failed (exit <code>)` — никогда адрес хоста, логин,
путь к файлу админского ключа или удалённую команду. Раскладка и dry-run
секрета, у которого нет сохранённой публичной половины ключа или она не
распознаётся, теперь заранее отказывают с `not_deployed` и заметкой `the
secret has no parseable public key half` вместо записи в `authorized_keys`
бесполезной строки, отрапортовавшей `deployed`. Контракт ssh-операций
описан в руководстве по хабу доступов.
