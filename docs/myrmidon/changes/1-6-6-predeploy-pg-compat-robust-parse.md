## changelog-en

### PREDEPLOY-PG-COMPAT: the version comparison and the extension read really run on Debian/PGDG servers (1.6.6)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — the dump-header parser
  kept only the leading major digits. A Debian/PGDG server records its version
  with the package tail (`; Dumped from database version: 18 (Debian
  18.6-1.pgdg12+2)`); the previous sed did not anchor the end, so the whole
  tail landed in `dump_major` and the arithmetic comparison died with
  `((: 18 (Debian 18.6-1.pgdg12+2): syntax error in expression` — bash does
  not abort on a failed arithmetic expression inside `if`, so the version
  check of the rc.11/rc.12 deploys (08.10) was silently skipped. The copy's
  `SHOW server_version` answer is parsed the same way.
- The two psql probes against the copy (`SHOW server_version`,
  `SELECT extname FROM pg_available_extensions`) no longer swallow stderr
  into `/dev/null`. They run through one helper that retries three times
  (`POLL_INTERVAL_SEC` apart) and captures the psql error; if the list still
  cannot be read, the WARNING names the captured error instead of failing
  silently. This is the second silent skip of the same deploys
  (`WARNING: the copy's extension list could not be read`).
- Tests: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — the fake
  docker answers the real Debian-tailed headers
  (`18 (Debian 18.6-1.pgdg12+2)`, `17.2 (Ubuntu 17.2-1.pgdg22.04+1)`) and can
  make each probe fail with a psql error. New cases: younger copy with a
  tailed header is refused with no `syntax error in expression` in the output,
  equal majors pass, the extension list is read and a missing extension is
  refused, a failing extension probe is retried and its error appears in the
  WARNING, the version WARNING carries the probe error. Every new case fails
  on the previous script.

## changelog-ru

### PREDEPLOY-PG-COMPAT: сравнение версий и чтение расширений действительно работают на серверах Debian/PGDG (1.6.6)

- `scripts/myrmidon/deploy/predeploy-board-check.sh` — разбор заголовка дампа
  теперь оставляет только ведущие цифры мажорной версии. Сервер Debian/PGDG
  записывает версию с хвостом пакета (`; Dumped from database version: 18
  (Debian 18.6-1.pgdg12+2)`); прежний sed не якорил конец строки, весь хвост
  попадал в `dump_major`, и арифметическое сравнение падало с
  `((: 18 (Debian 18.6-1.pgdg12+2): syntax error in expression` — bash не
  прерывает скрипт на неудачной арифметике внутри `if`, поэтому на выкатах
  rc.11/rc.12 (08.10) сравнение версий молча пропускалось. Ответ
  `SHOW server_version` копии разбирается так же.
- Два psql-запроса к копии (`SHOW server_version`,
  `SELECT extname FROM pg_available_extensions`) больше не глушат stderr в
  `/dev/null`. Они идут через один помощник: три попытки с интервалом
  `POLL_INTERVAL_SEC`, текст ошибки psql сохраняется; если список по-прежнему
  не читается, WARNING называет сохранённую ошибку вместо молчаливого отказа.
  Это второй молчаливый пропуск тех же выкатов
  (`WARNING: the copy's extension list could not be read`).
- Тесты: `scripts/myrmidon/deploy/predeploy-board-check.test.mjs` — фейковый
  docker отвечает настоящими заголовками с хвостом Debian
  (`18 (Debian 18.6-1.pgdg12+2)`, `17.2 (Ubuntu 17.2-1.pgdg22.04+1)`) и умеет
  ронять каждый запрос ошибкой psql. Новые случаи: младшая копия с заголовком
  с хвостом отклоняется без `syntax error in expression` в выводе, одинаковые
  мажоры проходят, список расширений читается и отсутствующее расширение
  отклоняется, падающий запрос расширений повторяется и его ошибка попадает в
  WARNING, WARNING о версии содержит ошибку запроса. Каждый новый случай
  красный на прежнем скрипте.
