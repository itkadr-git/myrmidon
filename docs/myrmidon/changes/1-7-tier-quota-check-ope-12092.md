## changelog-en

### TIER-QUOTA-CHECK: per-company agent quota by subscription tier (OPE-12092)

- Creating an agent (`POST /api/companies/{companyId}/agents`) now enforces
  the company's subscription-tier agent quota. When the number of active
  agents (every company agent whose status is not `terminated`) has reached
  or exceeded the quota, creation is rejected with `403 Forbidden` and
  `code: "quota_exceeded"`; the message names the tier, the current count and
  the quota. Within the quota, creation proceeds as before.
- A company without a row in `company_tiers` defaults to the `free` tier
  with an agent quota of **5**. A quota of `0` allows no new agents.
- The quota check runs as route middleware before validation and again in
  the agent-creation service, so both the API surface and internal callers
  see the same limit.
- Deployment safety: until the `company_tiers` table exists (the 1.7
  TIER-SCHEMA migration, OPE-12091, is not deployed yet), the check stays
  dormant — every creation passes and no instance gets a surprise 403.
  Database read failures are never interpreted as "quota OK": they
  propagate as errors (fail-closed) instead of silently widening the limit.
- Docs: `docs/myrmidon/guides/company-agent-quota.md` (+ `.ru.md`) and the
  "Company agent quota" section in the wiki (`docs/wiki/Agents-and-castes.md`
  / `.ru.md`).

## changelog-ru

### TIER-QUOTA-CHECK: лимит агентов компании по тарифу подписки (OPE-12092)

- Создание агента (`POST /api/companies/{companyId}/agents`) теперь
  проверяет квоту агентов тарифа компании. Если число активных агентов
  (все агенты компании, кроме завершённых — статус не `terminated`)
  достигло квоты или превысило её, создание отклоняется с `403 Forbidden`
  и `code: "quota_exceeded"`; в сообщении названы тариф, текущее число
  агентов и квота. В пределах квоты создание работает как раньше.
- Компания без строки в `company_tiers` получает тариф `free` по умолчанию
  с квотой **5** агентов. Квота `0` запрещает создание новых агентов.
- Проверка квоты работает как middleware маршрута перед валидацией и
  повторно в сервисе создания агента, поэтому и API, и внутренние вызовы
  видят один и тот же лимит.
- Безопасность выката: пока таблицы `company_tiers` нет (миграция 1.7
  TIER-SCHEMA, OPE-12091, ещё не развёрнута), проверка бездействует —
  создание разрешено всем, и ни один инстанс не получает внезапную 403.
  Ошибки чтения базы никогда не трактуются как «квота пройдена»: они
  пробрасываются наверх (fail-closed), а не молча расширяют лимит.
- Документация: `docs/myrmidon/guides/company-agent-quota.md`
  (+ `.ru.md`) и раздел «Лимит агентов компании по тарифу» в wiki
  (`docs/wiki/Agents-and-castes.md` / `.ru.md`).
