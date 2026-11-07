---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Foraging → knowledge proposals (KNOWLEDGE-2.0 L-5)

- A foraging finding no longer becomes a skill candidate directly. The
  foraging candidate port now routes to KNOWLEDGE first: every finding with a
  diff becomes exactly one `pending` knowledge suggestion (a proposal). The
  suggestion id is what lands in `foraging_findings.candidate_ref` — the
  candidate_ref of a foraged finding is the proposal itself. If the knowledge
  module cannot be constructed the previous skill-lifecycle port stays as the
  fallback; the null port (findings stay `unverified`) is still the last
  resort. No auto-accept, ever: the suggestion waits for a human decision on
  the suggestions review surface.
- Provenance is explicit: the suggestion row carries `trust=external` (the
  only source of a foraged claim is a foreign url) and the url as
  `source_ref` with `source_kind=url`. The column is new
  (`knowledge_suggestions.trust`, migration 0315, nullable — existing rows
  stay null = internal provenance).
- The foreign text never enters knowledge. The captured page text is
  quarantined as a document of the `foraging-inbox` corpus dataset (created
  per company on first finding; one document per finding, the raw lines in
  `metadata.markdown`, capped at 64 KiB, metadata carries
  `{role, skillKey, sourceId}`). Knowledge receives only our own retelling:
  a single-line body (summary + up to six added/removed lines joined by `|`)
  that cites the url. Quarantine first, proposal second — when the
  quarantine fails, no proposal is created (fail closed); when only the
  proposal fails, the quarantine document is kept and the finding stays
  `unverified`.
- The pass itself stays idle-only: this release also ports FORAGING-IDLE-GATE
  (1.6.3, OPE-4142) onto the 1.7 line — the per-role idle check (queue empty
  + a free agent of the role) gates every pass, `GET`/`PATCH
  /api/myrmidon/foraging/idle-gate` and Instance → General → "Foraging idle
  gate" are unchanged, `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` is the forced
  environment override.

## changelog-ru

### Фуражировка → предложения знаний (KNOWLEDGE-2.0 L-5)

- Находка фуражировки больше не превращается в кандидата навыка напрямую.
  Порт кандидатов фуражировки теперь ведёт сначала в ЗНАНИЯ: каждая находка
  с диффом становится ровно одним предложением знаний в статусе `pending`
  (пропозалом). Идентификатор предложения попадает в
  `foraging_findings.candidate_ref` — candidate_ref находки и есть
  предложение. Если модуль знаний невозможно сконструировать, предыдущий
  порт skill-lifecycle остаётся запасным; null-порт (находки остаются
  `unverified`) — последний рубеж. Автопринятия нет никогда: предложение
  ждёт решения человека на поверхности разбора предложений.
- Происхождение явно: строка предложения несёт `trust=external` (единственный
  источник форажированного утверждения — чужой url) и сам url как
  `source_ref` с `source_kind=url`. Колонка новая
  (`knowledge_suggestions.trust`, миграция 0315, nullable — существующие
  строки остаются null = внутреннее происхождение).
- Чужой текст в знания не попадает. Снятый текст страницы уходит в карантин —
  документ набора данных `foraging-inbox` (создаётся на компанию по первой
  находке; один документ на находку, сырые строки в `metadata.markdown`,
  потолок 64 КиБ, в metadata — `{role, skillKey, sourceId}`). Знания получают
  только собственный пересказ: однострочное тело (резюме + до шести
  добавленных/удалённых строк через `|`) со ссылкой на источник. Сначала
  карантин, потом предложение: если карантин не удался, предложение не
  создаётся (fail closed); если не удалось только предложение, документ
  карантина сохраняется, находка остаётся `unverified`.
- Сам проход по-прежнему только в простое: этот выпуск также переносит
  FORAGING-IDLE-GATE (1.6.3, OPE-4142) на линию 1.7 — по-ролевая проверка
  простоя (очередь пуста + свободный агент роли) стоит перед каждым
  проходом, `GET`/`PATCH /api/myrmidon/foraging/idle-gate` и Instance →
  General → «Foraging idle gate» без изменений,
  `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` — принудительное env-переопределение.
