## changelog-en

### Compact Myrmidon skill core, details on demand (OPE-11947)

- The bot-facing `myrmidon` skill is loaded into the context of every agent run, and it was 62,839 bytes (12.4% of all request characters measured over 28,128 requests of 21 bots). `skills/myrmidon/SKILL.md` is now a compact core of under 10,000 characters: identity and run-audit header, the heartbeat procedure, the final-disposition contract (statuses, real review and waiting paths, verified writes), comment and handoff rules, the critical rules, the most used API calls, and an index that names the reference file for each situation.
- Everything else moved verbatim into topical files under `skills/myrmidon/references/` (`auth-and-run-context`, `chat-turns`, `heartbeat-procedure`, `disposition-and-monitors`, `tasks-blockers-approvals`, `interactions-and-decisions`, `topic-pointers`, `secrets`, `critical-rules`, `comments-and-planning`, `hot-routes-and-search`). The original text of every section is preserved verbatim there; the core carries only condensed summaries.
- New rules in the core: load the skill once per run and never re-open it after context compaction; never print full board JSON (select fields with `jq`, bound lists with `limit`/`view=compact`, use `Prefer: return=minimal` on `PATCH`).
- The runner capability inventory (`packages/paperclip-runner`) now lists the relocated reference files as skill sources and its generated baselines are regenerated (163 skill and reference headings, 164 in the generated contract).

## changelog-ru

### Компактное ядро навыка Myrmidon, подробности по требованию (OPE-11947)

- Навык `myrmidon` для ботов загружается в контекст каждого прогона агента, и он весил 62 839 байт (12,4% всех символов запросов по выборке из 28 128 запросов 21 бота). `skills/myrmidon/SKILL.md` теперь компактное ядро короче 10 000 символов: идентичность и заголовок аудита прогона, порядок побудки, контракт финального статуса (статусы, настоящие пути ревью и ожидания, проверка записей), правила комментариев и передачи, критические правила, самые частые вызовы API и указатель, какой справочный файл открывать в какой ситуации.
- Всё остальное перенесено дословно в тематические файлы `skills/myrmidon/references/` (`auth-and-run-context`, `chat-turns`, `heartbeat-procedure`, `disposition-and-monitors`, `tasks-blockers-approvals`, `interactions-and-decisions`, `topic-pointers`, `secrets`, `critical-rules`, `comments-and-planning`, `hot-routes-and-search`). Исходный текст каждого раздела сохранён там дословно; в ядре только сжатые выжимки.
- Новые правила в ядре: загружать навык один раз за прогон и не открывать заново после сжатия контекста; не печатать целиком JSON доски (выбирать поля через `jq`, ограничивать списки `limit`/`view=compact`, на `PATCH` слать `Prefer: return=minimal`).
- Инвентарь возможностей раннера (`packages/paperclip-runner`) теперь включает перенесённые файлы как источники навыка, его сгенерированные базовые файлы пересозданы (163 заголовка навыка и справочников, 164 в сгенерированном контракте).
