# Перенос знания из плагина: `knowledge-migrate` (KNOWLEDGE-2.0, K-6)

Инженер запускает скрипт, оператор правит карту slug'ов. Цель переноса —
знание, а не файлы: каждая страница вики плагина либо становится страницей
модуля знаний, либо вливается в существующую, либо осознанно не переносится.

## Команды

```bash
# 1. План: классы §5.3, сумма классов, доля резолва ссылок, черновик карты.
pnpm knowledge:migrate classify --root /path/to/plugin-wiki-export --emit-map migrate-map.json

# 2. Импорт: сначала всегда dry-run, потом по-настоящему.
pnpm knowledge:migrate import --root /path/to/plugin-wiki-export \
  --map migrate-map.json --company-id <uuid компании> --dry-run
pnpm knowledge:migrate import --root /path/to/plugin-wiki-export \
  --map migrate-map.json --company-id <uuid компании> --actor-agent <id агента>
```

Общие флаги: `--dry-run` (считать всё, не писать ничего), `--out <файл>`
(положить отчёт JSON в файл вместо stdout), `--catalog <файл>` (дампа
`wiki_pages`, если он есть), `--expected-total <n>` (контроль суммы классов,
по умолчанию 170 — §5.3). Обе команды возвращают ненулевой код выхода, если
сумма классов не сошлась или страница не записалась: молчаливого «почти
получилось» не бывает.

`import` требует базу: `DATABASE_URL` (или конфиг сервера).

## Карта slug'ов (`migrate-map.json`)

Карту правит оператор руками — скрипт только сеет шаблон (`--emit-map`) и
затем читает то, что написал человек. Регулярки и угадывание запрещены: если
страницы нет в карте, берётся правило классификатора, а нерешаемый путь
(ошибка `Unclassified source path`) останавливает прогон.

```json
{
  "version": 1,
  "expectedTotal": 170,
  "defaultSources": ["OPE-3933"],
  "pages": {
    "myrmidon/company-bootstrap.md": { "class": "A", "action": "import", "target": "architecture/company-bootstrap" },
    "regulations/secrets.md": { "class": "B", "action": "import", "target": "regulations/secrets", "kind": "rule", "approverKind": "owner" },
    "arch/old-answer.md": { "class": "C", "action": "merge", "target": "arch/old-answer", "mergeInto": "architecture/company-bootstrap" },
    "projects/alpha/index.md": { "class": "D", "action": "drop" }
  },
  "checks": [
    { "query": "bootstrap", "expect": "architecture/company-bootstrap" },
    { "query": "roles", "expect": "product/roles-and-castes" },
    { "query": "release 1.6", "expect": "releases/1.6.0" }
  ]
}
```

Поля страницы: `class` (A–G), `action` (`import` | `merge` | `drop` |
`replace_index`), `target` (slug в модуле знаний), `mergeInto` (во что
вливается класс C), `kind` (`wiki`/`rule`/…), `approverKind` (для `rule`),
`publish` (импорт мимо ревью), `sources`, `tags`, `title`. Действию `import`
и `merge` нужен `target` либо `mergeInto` — карта с действием без цели не
принимается.

`checks` — три контрольных запроса §5.3: после импорта каждый должен найти
ожидаемую страницу. Отчёт показывает, сколько нашлось.

## Порядок работы

1. Выгрузить вики плагина (каталог с `.md`-страницами; `raw/`, `AGENTS.md`,
   `IDEA.md` и логи скрипт пропускает сам).
2. `classify --emit-map migrate-map.json` — получить шаблон карты и числа.
3. Оператор правит карту: раскладывает класс C по целям (`mergeInto`),
   вычищает лишнее, дописывает то, что классификатор не умеет решать.
4. `import --dry-run` — сверить числа: сумма классов = `expectedTotal`,
   доля резолва ссылок ≥ 90 %, список нерезолвленных целей.
5. Дописать `checks` (три контрольных запроса) и выполнить `import`.
6. Сверить отчёт: `created`, `appended`, `superseded`, `failed` (должно быть
   пусто), `links.percent`, `checks`.

## Что гарантирует отчёт

- Классы A–G по каждой странице и их сумма против `expectedTotal` (§5.3:
  170) — расхождение это красный результат, а не примечание.
- Доля резолва `[[…]]`: ссылка, которую карта не объясняет, остаётся в тексте
  дословно и попадает в `unresolvedTargets` — ссылки не выдумываются.
- Каждая перенесённая страница: ревизия, источники (`wiki/<путь>` + ссылки
  из frontmatter + `defaultSources`), разобранный frontmatter (в отчёт идут
  только имена ключей).
- Тела страниц и значения полей не печатаются ни в stdout, ни в JSON-отчёт:
  страницы вики могут нести персональные данные.

## Критерии K-6 (§6) и где они проверяются

- сумма классов = 170 → `classSum.expected` / `classSum.actual` / `classSum.ok`,
  плюс ненулевой код выхода при расхождении;
- у каждой перенесённой страницы есть ревизия, источники и разобранный
  frontmatter → `created` / `appended` / `revisionsWritten`, `sources`,
  `frontmatterParsed` и `frontmatter.keys` (в отчёт идут только имена ключей);
- ссылки резолвлены ≥ 90 % → `links.total` / `links.resolved` /
  `links.percent` и `links.unresolvedTargets`;
- три контрольных запроса находят ожидаемое → `checks` в карте и результаты
  в `report.checks`;
- содержимое не печатается → в отчёте только числа, слаги и имена ключей;
  юнит-тесты `server/src/myrmidon/knowledge/migrate/migrate.myrmidon.test.ts`
  проверяют это на живом прогоне `classify`/`import`.

## Роли

- Инженер: прогон `classify`/`import`, разбор отчёта, разбор нерезолвленных
  ссылок и упавших страниц.
- Оператор: карта slug'ов, цели слияний класса C, `checks`, решение о
  публикации регламентов (импортируются черновиками и требуют утверждения).