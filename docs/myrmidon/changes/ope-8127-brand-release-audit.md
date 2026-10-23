---
divergence-section: Брендинг
---

## changelog-en

### DEBRAND 1.6.6: release brand audit and root-docs cleanup (OPE-8127)

- New release audit `scripts/myrmidon/brand-release-audit.mjs` scans everything
  the release ships that `docs-branding-guard.mjs` did not cover: the root
  `README.md`/`README.ru.md`, `CONTRIBUTING.md`, `ROADMAP.md`, `DESIGN.md`,
  `AGENTS.md`, `CLAUDE.md` plus all of `docs/`. Report mode always exits 0 and
  prints the exact count and paths of non-allowlisted old-brand mentions;
  `--gate` fails on any finding (for a release-workflow maintainer commit).
- The allowlist is exact substrings with categories (vendor identifiers, legal
  attribution, compatibility identifiers, external vendor services, historical
  records, provenance prose) — never a file glob. The fixture tests pin this:
  a glob-like entry fails the suite, and a compatibility identifier on the same
  line does not mask a product mention next to it.
- Root docs cleaned: product prose in `CONTRIBUTING.md`, `ROADMAP.md`,
  `DESIGN.md`, `AGENTS.md` now says Myrmidon (46 findings at audit time → 0
  non-allowlisted). License attribution lines in the READMEs and vendor
  identifiers (`@paperclipai/*`, `PAPERCLIP_*`, CLI `paperclipai`, the
  `paperclip` skill path and API name) are untouched.
- Read-only release check instruction:
  `docs/myrmidon/guides/brand-release-check.md` (EN, with an RU summary) —
  how to audit UI copy, bot/log texts, and API answers by hand before a tag,
  without touching runtime or configuration.
- Fixture tests: `scripts/myrmidon/brand-release-audit.test.mjs`
  (7 cases: forbidden mention fails the gate; legal attribution green; hidden
  compatibility boundary green; same-line identifier does not mask prose;
  report mode exits 0 with findings; no glob-like allowlist entry; UI/log
  lines never allowlisted wholesale). Runs under the existing
  "Script tests (node:test under scripts/myrmidon)" CI step.

## changelog-ru

### DEBRAND 1.6.6: релизный аудит бренда и чистка корневой документации (OPE-8127)

- Новый релизный аудит `scripts/myrmidon/brand-release-audit.mjs` проверяет то,
  что не покрывал `docs-branding-guard.mjs`: корневые `README.md`/`README.ru.md`,
  `CONTRIBUTING.md`, `ROADMAP.md`, `DESIGN.md`, `AGENTS.md`, `CLAUDE.md` и весь
  `docs/`. Режим отчёта всегда выходит с кодом 0 и печатает точное количество и
  пути не-аллоулистных упоминаний старого бренда; `--gate` падает на любом
  найденном (для коммита мейнтейнера в релизный workflow).
- Аллоулист — точные подстроки по категориям (идентификаторы вендора,
  юридическая атрибуция, compatibility-идентификаторы, внешние сервисы вендора,
  исторические записи, проза о происхождении форка) — никогда не glob по файлам.
  Это зафиксировано fixture-тестами: glob-подобная запись роняет набор, а
  compatibility-идентификатор в той же строке не маскирует упоминание продукта
  рядом.
- Корневые документы почищены: проза продукта в `CONTRIBUTING.md`, `ROADMAP.md`,
  `DESIGN.md`, `AGENTS.md` говорит Myrmidon (46 находок на момент аудита → 0
  не-аллоулистных). Лицензионная атрибуция в README и идентификаторы
  совместимости (`@paperclipai/*`, `PAPERCLIP_*`, CLI `paperclipai`, путь
  навыка `paperclip` и имя API) не тронуты.
- Инструкция read-only проверки релиза:
  `docs/myrmidon/guides/brand-release-check.md` — как перед тегом вручную
  проверить тексты UI, логи/тексты ботов и ответы API, не трогая рантайм и
  конфигурацию.
- Fixture-тесты: `scripts/myrmidon/brand-release-audit.test.mjs`
  (7 кейсов) — выполняются существующим шагом CI
  «Script tests (node:test under scripts/myrmidon)».

## divergence

| DEBRAND-8127 | Релизный аудит бренда: `scripts/myrmidon/brand-release-audit.mjs` (режимы report/`--gate`) + 7 fixture-тестов; аллоулист — точные подстроки по категориям, glob запрещён тестом. Корневые документы (README*/CONTRIBUTING/ROADMAP/DESIGN/AGENTS/CLAUDE) — проза продукта переименована в Myrmidon; атрибуция и идентификаторы совместимости сохранены. Гайд read-only проверки перед тегом: `guides/brand-release-check.md` | Наши файлы поверх вендорских: CONTRIBUTING.md, ROADMAP.md, DESIGN.md, AGENTS.md, CLAUDE.md (правки только текста, идентификаторы не тронуты) + новые scripts/myrmidon/brand-release-audit{,.test}.mjs, docs/myrmidon/guides/brand-release-check.md, docs/myrmidon/changes/ope-8127-brand-release-audit.md | Часть DEBRAND 1.6.6 (OPE-5794): сторож docs/ не покрывал корень репозитория; релизный аудит должен показывать остатки бренда, а не молчать | `scripts/myrmidon/brand-release-audit.test.mjs` (7 кейсов, node --test), сам аудит зелёный на дереве | Когда все части DEBRAND сойдутся, включить `--gate` в релизный workflow (коммит мейнтейнера); аллоулист сокращается вместе с переименованием кодовых эпиков | (этот PR) |
