---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### botd classifier of foreign copies and scratch (1.6.5 BOT-DISK-H, part H3d)

- New `docker/bot-runtime/botd/lib/classify.js`: walks `/workspace`, `/scratch`
  and `/data/hermes/cache/scratch` and puts every directory into class E (task
  copy), G (scratch) or X (foreign) with a sign: `promisor`, `token`,
  `no-remote`, `trash`, `full-clone`. Output is a list of
  `{path, class, sign, ageSec, sizeBytes}` plus an action per item for the
  lifecycle rules (scratch removed after a 24 h TTL by mtime/ctime; foreign
  copies get a card at once and are held while a task with the same key is
  active; nothing is removed when the board is unreachable).
- Repositories are read as text (`.git/config`), never through git, because a
  repository's own config can name programs git would run. A credential in a
  remote URL is only ever reported as the flag `token`; the first pass can
  rewrite `remote.origin.url` without userinfo with `git remote set-url` and
  returns the count.

## changelog-ru

### Классификатор чужого и scratch в botd (1.6.5 BOT-DISK-H, часть H3d)

- Новый `docker/bot-runtime/botd/lib/classify.js`: обходит `/workspace`,
  `/scratch` и `/data/hermes/cache/scratch` и относит каждый каталог к классу E
  (копия задачи), G (scratch) или X (чужое) с признаком: `promisor`, `token`,
  `no-remote`, `trash`, `full-clone`. Результат — список
  `{path, class, sign, ageSec, sizeBytes}` и действие для правил жизненного
  цикла на каждый элемент (scratch удаляется по TTL 24 ч по mtime/ctime; чужому
  сразу карточка, и его не трогают, пока жива задача с тем же ключом; при
  недоступной доске ничего не удаляется).
- Репозитории читаются как текст (`.git/config`), не через git: конфиг самого
  репозитория может назвать программы, которые git запустит. Учётные данные в
  URL remote выходят только флагом `token`; первый проход может переписать
  `remote.origin.url` без userinfo через `git remote set-url` и возвращает счётчик.

## divergence

| 1.6.5-BOT-DISK-H3d | Классификатор E/G/X для botd: признаки promisor/token/no-remote/trash/full-clone, TTL scratch, «не трогать до closing», перезапись `remote.origin.url` без userinfo | Наши файлы: `docker/bot-runtime/botd/lib/classify.js`, `scripts/myrmidon/bot-runtime/botd-classify.test.mjs`. Маркеров вендора нет: файлы наши | Токены в URL у свежих клонов и 10 ГиБ promisor-паков; требование тикета OPE-5356 (часть H3 проекта, раздел C4 контракта) | `botd-classify.test.mjs` (фикстуры классов и признаков, TTL, живая задача, токен не в выводе, set-url и счётчик, схемы контракта) | Никогда, наше поведение. Снятие: удалить `botd/lib/classify.js`, тест и фрагмент доков | (этот PR) |
