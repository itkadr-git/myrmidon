---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Knowledge module: transfer from the plugin (KNOWLEDGE-2.0 K-6)

- New `server/src/myrmidon/knowledge/migrate/`: `frontmatter.ts` (a
  frontmatter parser with no dependency — values never leave the process,
  only key names reach the report), `classify.ts` (the §5.3 class rules as a
  deterministic, path-based classifier; the only rule that reads the file is
  the stub rule, and it reads its length), `map.ts` (the operator-authored
  slug map: parsed hard, never guessed), `links.ts` (`[[…]]` rewritten into
  knowledge slugs, unresolved targets kept verbatim and counted),
  `source.ts` (reads the plugin wiki export), `report.ts` (numbers-only
  reports), `run.ts` (`classify` plans, `import` writes through the K-1
  service), `index.ts` (barrel).
- New `scripts/knowledge-migrate.ts` + `pnpm knowledge:migrate`:
  `classify --root <export> [--emit-map <file>]` seeds the operator's map and
  prints the class counts, their sum and the link rate; `import --root <export>
  --map <map.json> --company-id <uuid> [--nest-id <uuid>] [--actor-agent <id>]`
  writes items, revisions, sources and supersedes. Both accept `--dry-run`
  (compute everything, write nothing) and both exit non-zero when the class sum
  does not match `expectedTotal` or a page failed.
- Every imported page gets a revision, a source list (`wiki/<path>` plus the
  page's own frontmatter refs and the map's `defaultSources`) and its parsed
  frontmatter fields (title, tags, summary); regulations are imported as
  `kind=rule` drafts with their `approverKind`. Class C pages are created and
  then superseded by their `mergeInto` target. A second source page for the
  same target is appended as an extra revision — its knowledge is not dropped.
- The report holds numbers, class names, slugs and frontmatter *key names*;
  page bodies and field values are never printed (§5.3: pages can carry
  personal data).
- The map's `kind` is validated against the domain's own knowledge kinds, so a
  typo (`rulle`) fails while the map is parsed, not halfway through writing.
  Links also resolve when they are written as the *title* of an imported page —
  the form the plugin wiki used most — so a title-only link no longer counts as
  unresolved. A regulation whose name §5.3 does not know has no approver and
  fails on write with `rule_requires_approver_kind`; the operator runbook says
  so and tells the operator to set `approverKind` in the map.
- Tests: `server/src/myrmidon/knowledge/migrate/migrate.myrmidon.test.ts`
  (frontmatter parsing, every class rule, map validation, link rewriting,
  classify report invariants, and `runImport` over a stub writer: create,
  shared-target append, supersede, dry-run, failure reporting).

## changelog-ru

### Модуль знаний: перенос из плагина (KNOWLEDGE-2.0 K-6)

- Новый `server/src/myrmidon/knowledge/migrate/`: `frontmatter.ts` (разбор
  frontmatter без зависимостей — значения не покидают процесс, в отчёт идут
  только имена ключей), `classify.ts` (§5.3 как детерминированный
  классификатор по пути; единственное правило, читающее файл, — правило
  заглушек, и только его размер), `map.ts` (карта slug'ов — артефакт
  оператора: разбирается строго, не угадывается), `links.ts` (`[[…]]`
  переписываются в slug'и знаний, нерезолвленные остаются дословно и
  считаются), `source.ts` (чтение выгрузки вики плагина), `report.ts` (отчёты
  только числами), `run.ts` (`classify` планирует, `import` пишет через
  сервис K-1), `index.ts` (баррель).
- Новый `scripts/knowledge-migrate.ts` + `pnpm knowledge:migrate`:
  `classify --root <выгрузка> [--emit-map <файл>]` сеет карту оператора и
  печатает классы, их сумму и долю резолва ссылок; `import --root <выгрузка>
  --map <map.json> --company-id <uuid> [--nest-id <uuid>] [--actor-agent <id>]`
  пишет элементы, ревизии, источники и supersede. У обеих команд есть
  `--dry-run` (считает всё, не пишет ничего); обе выходят с ненулевым кодом,
  если сумма классов не сошлась с `expectedTotal` или страница упала.
- Каждая перенесённая страница получает ревизию, список источников
  (`wiki/<путь>` + ссылки из frontmatter страницы + `defaultSources` карты) и
  разобранные поля frontmatter (title, tags, summary); регламенты
  импортируются черновиками `kind=rule` со своим `approverKind`. Страницы
  класса C создаются и затем supersede своей целью `mergeInto`. Вторая
  страница на ту же цель дописывается отдельной ревизией — знание не теряется.
- В отчёте только числа, имена классов, slug'и и *имена ключей* frontmatter;
  тела страниц и значения полей не печатаются (§5.3: страницы могут нести
  персональные данные).
- `kind` в карте проверяется по списку родов знания из домена: опечатка
  (`rulle`) падает на разборе карты, а не посреди записи. Ссылки резолвятся и
  тогда, когда записаны *заголовком* страницы, — именно так писала вики
  плагина, — поэтому ссылка по заголовку больше не считается нерезолвленной.
  Регламент с незнакомым §5.3 именем остаётся без утверждающего и падает на
  записи с `rule_requires_approver_kind`; runbook оператора говорит об этом и
  требует выставить `approverKind` в карте.
- Тесты: `server/src/myrmidon/knowledge/migrate/migrate.myrmidon.test.ts`
  (разбор frontmatter, все правила классов, валидация карты, переписывание
  ссылок, инварианты отчёта classify и `runImport` на заглушке-писателе:
  create, дописывание в общую цель, supersede, dry-run, отчёт об ошибке).

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-6: перенос знания из плагина (knowledge-migrate classify/import)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-K6 | Перенос знания из плагина-моста: `knowledge-migrate classify` (детерминированный классификатор §5.3 по пути, сев карты slug'ов оператора, отчёт числами: классы A–G и их сумма, доля резолва `[[…]]`, имена ключей frontmatter, нерешённые слияния) и `knowledge-migrate import` (пишет через сервис K-1: элемент + ревизия + источники `wiki/<путь>` и из frontmatter, `kind=rule` для регламентов с `approverKind`, класс C создаётся и затем supersede по `mergeInto`, вторая страница на ту же цель — отдельная ревизия, а не потеря). У обеих команд `--dry-run`, отчёт только числами (тела страниц не печатаются), ненулевой код выхода при расхождении суммы классов с `expectedTotal` или падении страницы. Карту slug'ов правит оператор руками (`--emit-map` только сеет шаблон). | Наши файлы: `server/src/myrmidon/knowledge/migrate/` (весь каталог), `scripts/knowledge-migrate.ts`; в вендоре помечены: `package.json` (скрипт `knowledge:migrate`) | Вики плагина выводится из эксплуатации после переноса знаний в модуль знаний 1.6.6; перенос делает инженер скриптом, а решения о судьбе каждой страницы — оператор картой | `migrate.myrmidon.test.ts` (разбор frontmatter, правила всех классов §5.3, строгая валидация карты, переписывание `[[…]]` с алиасом/якорем, инварианты отчёта и суммы классов, `runImport` на заглушке: create/дописывание/supersede/dry-run/ошибка страницы) | Никогда, наше поведение. Скрипт остаётся для повторного/частичного переноса | (этот PR) |