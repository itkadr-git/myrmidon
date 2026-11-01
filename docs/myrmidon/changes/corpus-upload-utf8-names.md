## changelog-en

### Corpus keeps non-ASCII file names intact on upload (1.6.6 CORPUS-2.0)

- The corpus upload route now reads the file name of a multipart upload as UTF-8.
  Browsers and HTTP clients send the name as raw UTF-8 bytes, but the multipart
  parser read it as latin1 by default. A Cyrillic name such as `Руководство.pdf`
  was saved as unreadable text in the document title, in the API answers and in the
  audit log. New uploads keep their name.
- Documents uploaded before this fix keep the garbled title. Delete such a document
  and upload it again to get the correct name.

## changelog-ru

### Корпус сохраняет имена файлов не из ASCII при загрузке (1.6.6 CORPUS-2.0)

- Маршрут загрузки корпуса теперь читает имя файла из multipart-запроса как UTF-8.
  Браузеры и HTTP-клиенты шлют имя сырыми байтами UTF-8, а разборщик multipart по
  умолчанию читал его как latin1. Кириллическое имя вроде `Руководство.pdf`
  сохранялось нечитаемым текстом в заголовке документа, в ответах API и в журнале
  аудита. Новые загрузки сохраняют имя как есть.
- Документы, загруженные до исправления, сохраняют искажённый заголовок. Чтобы
  получить верное имя, удалите такой документ и загрузите его заново.
