---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Secret proposals can rotate an existing secret (SECRET-PROPOSAL-ROTATE)

- A `kind=secret` agent proposal now accepts `rotateSecretId`. On approval the
  proposed value becomes a new version of that secret (compare-and-set on the
  active version), and `@latest` bindings pick it up; rotation never renames
  the secret. The approve dialog shows the target, fingerprint and status.
- A proposal whose name is already taken now fails with `409` at creation (and
  at approval for old pending proposals) instead of becoming an unapprovable
  dead end.
- A `kind=binding` proposal may retarget a path that already holds a company
  secret reference (only the secret part is compared); plain values and
  user-secret bindings still require an exact match.
- Migration `0404_secret_proposal_rotation_target` adds the nullable column
  `company_secret_proposals.rotation_target_secret_id` with a foreign key.

## changelog-ru

### Пропозал секрета может ротировать существующий секрет (SECRET-PROPOSAL-ROTATE)

- Агентский пропозал `kind=secret` принимает поле `rotateSecretId`. При одобрении
  предложенное значение становится новой версией этого секрета (compare-and-set по
  активной версии), биндинги `@latest` подхватывают её сами; секрет при ротации не
  переименовывается. Диалог одобрения показывает цель, фингерпринт и статус.
- Пропозал с занятым именем теперь отклоняется с `409` при создании (и при одобрении
  для старых ожидающих), а не превращается в неодобряемый тупик.
- Пропозал `kind=binding` может перенацелить путь, где уже лежит ссылка на секрет
  компании (сравнивается только секретная часть); простые значения и пользовательские
  секреты по-прежнему требуют точного совпадения.
- Миграция `0404_secret_proposal_rotation_target` добавляет nullable-колонку
  `company_secret_proposals.rotation_target_secret_id` с внешним ключом.

## divergence

| 1.6.6-SECRET-PROPOSAL-ROTATE | Ротация существующего секрета через пропозал (`rotateSecretId`), пре-чек конфликта имени, ретаргет binding-пропозала на secret_ref | `server/src/services/secret-proposals.ts`, `server/src/routes/secrets.ts`, `packages/db/src/schema/company_secret_proposals.ts`, миграция `0404_secret_proposal_rotation_target.sql` и мета, `ui/src/pages/secrets/proposal-review.tsx` | Агентский путь не мог довести ротацию до конца: approve падал 409, ротация только для board | `server/src/__tests__/secret-proposals-routes.test.ts`, `packages/db/src/company-secret-proposals-migration.test.ts` | Когда вендор сам добавит ротацию через пропозалы — удалить поле, колонку и ветки; миграция односторонняя | (этот PR) |
