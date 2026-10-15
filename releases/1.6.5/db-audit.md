# db-audit 1.6.5 — указатель

Аудит базы, который идёт в релиз 1.6.5, лежит по адресу, названному правилом владельца
(`doc/RELEASE-CHECKLIST.md`, «Database audit (required before every final tag)»):

    docs/myrmidon/releases/1.6.5-db-audit.md

Этот файл (`releases/1.6.5/db-audit.md`) существует как точка входа для критерия приёмки
задачи OPE-5942 («`releases/1.6.5/db-audit.md` лежит в репозитории») и намеренно не
дублирует содержимое: канонический отчёт один.

Коротко о статусе на 08.10.2026:

- снимок — ручной аудит OPE-4270 от 04.10.2026 (PostgreSQL 17.11, окно 13 ч 37 мин);
- с 1.6.5 числа собирает сама доска: модуль `server/src/myrmidon/datastore-care/`
  (ежечасные снимки в `datastore_snapshots`, отчёты по кнопке в `datastore_audit_reports`,
  срок 90 дней, экспорт `.md`);
- гейт: `bash scripts/myrmidon/release/db-audit-gate.sh --report <report.json> --mode warn`
  — для 1.6.5 в режиме предупреждения (со следующего релиза `--mode block`);
- перед финальным тегом 1.6.5 срез «после» снимается на живой базе — см. §6 отчёта.