---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Verified skills use a git record (KNOWLEDGE-2.0 L-13)

- When `MYRMIDON_SKILL_GIT_ENABLED=1` and a repository is configured, promotion records the exact verified skill snapshot in git before the lifecycle row becomes verified. A failed record or push fails closed.
- Startup and the signed `/api/myrmidon/skill-git-record/webhook` refresh the local mirror. A verified skill missing from git or differing from its verified database snapshot is marked as drift and withheld from delivery; the Skills lifecycle screen shows the reason.
- The record uses the configured repository's `skills/<key>/` tree and commits only skill files. No token is placed in a git argument or log.

## changelog-ru

### Проверенные навыки используют запись в git (KNOWLEDGE-2.0 L-13)

- При `MYRMIDON_SKILL_GIT_ENABLED=1` и настроенном репозитории повышение сначала записывает точный снимок проверенного навыка в git, и только затем строка жизненного цикла становится verified. Сбой записи или отправки останавливает операцию.
- При старте и по подписанному `/api/myrmidon/skill-git-record/webhook` локальная копия обновляется. Проверенный навык, отсутствующий в git или отличающийся от снимка в базе, помечается как drift и не доставляется; экран жизненного цикла показывает причину.
- Запись использует дерево `skills/<key>/` настроенного репозитория и коммитит только файлы навыка. Токен не попадает ни в аргументы git, ни в журнал.

## divergence-new

### 1.7 — KNOWLEDGE-2.0 L-13: git record for verified skills

The verified skill record is an explicit bridge for architecture invariant I-6: the configured git repository owns the exact file snapshot of a verified skill. `skill_promotion` records that snapshot before saving the lifecycle state. Startup and the signed webhook refresh the local mirror; delivery fails closed and exposes `missing` or `content_mismatch` drift when the database's verified snapshot has no exact git counterpart. Candidate skills remain database-only and follow the existing pilot delivery rules.

| ID | What changes | Vendor files | Why | Test guard | How to remove | PR |
|---|---|---|---|---|---|---|
| 1.7-KNOWLEDGE-L13 | Add `server/src/myrmidon/skill-git-record/` with path-safe git recording, signed refresh, drift detection and fail-closed delivery; lifecycle promotion calls the record port before persisting `verified` | `server/src/app.ts`, `server/src/index.ts`, `server/src/myrmidon/skill-lifecycle/service.ts`, `server/src/myrmidon/skill-lifecycle/index.ts`, `ui/src/components/myrmidon/skill-lifecycle/` | Architecture decision D13 recommends git as the source of record for verified skills while keeping database candidates and lifecycle state | `server/src/myrmidon/skill-git-record/skill-git-record.myrmidon.test.ts` and existing lifecycle guards | Remove the git record port and call sites; with the feature disabled the pre-feature database delivery remains unchanged | (this PR) |

## settings-en-new

<!-- after: 1.6 — SKILL-LIFECYCLE: company skill lifecycle -->

### 1.7 — KNOWLEDGE-2.0 L-13 (git record of verified skills)

The git record is disabled unless `MYRMIDON_SKILL_GIT_ENABLED=1` and `MYRMIDON_SKILL_GIT_REPOSITORY` is set. `MYRMIDON_SKILL_GIT_PUSH=1` pushes commits after recording; otherwise commits remain in the configured checkout. `MYRMIDON_SKILL_GIT_WEBHOOK_SECRET` enables HMAC `X-Hub-Signature-256` validation for `/api/myrmidon/skill-git-record/webhook`. The feature fails closed for verified delivery when enabled and git is missing or differs.

## settings-ru-new

<!-- after: Трек 4 — чаты и навыки -->

### 1.7 — KNOWLEDGE-2.0 L-13 (запись verified-навыков в git)

Запись в git выключена, пока не заданы `MYRMIDON_SKILL_GIT_ENABLED=1` и `MYRMIDON_SKILL_GIT_REPOSITORY`. `MYRMIDON_SKILL_GIT_PUSH=1` отправляет коммиты после записи; иначе коммиты остаются в настроенной рабочей копии. `MYRMIDON_SKILL_GIT_WEBHOOK_SECRET` включает проверку HMAC `X-Hub-Signature-256` для `/api/myrmidon/skill-git-record/webhook`. При включённой функции проверенный навык не доставляется, если git отсутствует или отличается.
