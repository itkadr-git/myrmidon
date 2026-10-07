---
settings-section: 1.6 — SKILL-LIFECYCLE: company skill lifecycle
---

## changelog-en

### Bot skill back-import: bot-authored skills land in the company catalog (SKILL-BACKIMPORT)

- New module `server/src/myrmidon/skill-backimport/`: a periodic sweep that
  reads the skills root (`<bot root>/hermes/skills`) of every running
  hermes_gateway bot container and imports each new bot-authored skill into
  the company skill catalog (catalog row, version snapshot, lifecycle
  candidate). A skill a bot writes in its own volume is no longer lost when
  the volume is recreated: the board owns a copy and the profile compiler
  delivers it again.
- Everything is off unless `MYRMIDON_BOT_SKILL_BACKIMPORT` is set; the cadence
  is `MYRMIDON_BOT_SKILL_BACKIMPORT_INTERVAL_SEC` (default 300 s).
- The sweep never overwrites a skill the catalog already has (the board stays
  the authority), never imports the bot's `skills.pre-myrmidon` backup, and
  one failing bot never stops the pass. Reads go through the container
  driver's per-bot calls (dockergate allows no global listing); the
  orchestration itself is driver-free and unit-tested against fakes.

## changelog-ru

### Обратный импорт навыков ботов: навыки, созданные ботом, попадают в каталог доски (SKILL-BACKIMPORT)

- Новый модуль `server/src/myrmidon/skill-backimport/`: периодический обход
  читает корень навыков (`<корень бота>/hermes/skills`) каждого работающего
  контейнера бота hermes_gateway и импортирует каждый новый навык, созданный
  ботом, в каталог навыков компании (строка каталога, снапшот версии,
  кандидат жизненного цикла). Навык, который бот написал в свой том, больше
  не теряется при пересоздании тома: копия остаётся у доски, и компилятор
  профиля снова её доставляет.
- Всё выключено, пока не задан `MYRMIDON_BOT_SKILL_BACKIMPORT`; период —
  `MYRMIDON_BOT_SKILL_BACKIMPORT_INTERVAL_SEC` (по умолчанию 300 с).
- Обход никогда не перезаписывает навык, уже есть в каталоге (доска остаётся
  авторитетом), не импортирует резервную копию `skills.pre-myrmidon`, и сбой
  одного бота не останавливает проход. Чтение идёт через поштучные вызовы
  драйвера контейнеров (dockergate не даёт общего листинга); сама
  оркестрация от драйвера изолирована и покрыта юнит-тестами на заглушках.

## settings-en

| `MYRMIDON_BOT_SKILL_BACKIMPORT` | SKILL-BACKIMPORT | unset (off) | Periodic sweep that imports new bot-authored skills from the running bots' container skills roots into the company catalog (row + version + lifecycle candidate), so a skill a bot wrote survives a recreation of its volume | Unset or any value that is not `1`/`true`/`yes`/`on` — no reads, no writes, the current behaviour |
| `MYRMIDON_BOT_SKILL_BACKIMPORT_INTERVAL_SEC` | SKILL-BACKIMPORT | 300 | Seconds between back-import passes (60..86400; junk or out of range falls back to the default) | Not applicable: without `MYRMIDON_BOT_SKILL_BACKIMPORT` the sweep does not start |

## settings-ru

| `MYRMIDON_BOT_SKILL_BACKIMPORT` | SKILL-BACKIMPORT | не задан (выкл) | Периодический обход, импортирующий новые навыки, созданные ботом, из корня навыков контейнера в каталог компании (строка + версия + кандидат жизненного цикла), чтобы навык переживал пересоздание тома | Не задан или любое значение, кроме `1`/`true`/`yes`/`on` — ни чтения, ни записи, текущее поведение |
| `MYRMIDON_BOT_SKILL_BACKIMPORT_INTERVAL_SEC` | SKILL-BACKIMPORT | 300 | Период обхода обратного импорта навыков, секунды (60..86400; мусор и выход за диапазон — откат к умолчанию) | Не применимо: без `MYRMIDON_BOT_SKILL_BACKIMPORT` обход не запускается |
