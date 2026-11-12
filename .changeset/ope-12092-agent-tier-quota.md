---
'@myrmidon/server': patch
---

Agent creation now enforces the company's subscription-tier agent quota: over the quota the create call returns 403 with `code: "quota_exceeded"`; a company without a `company_tiers` row defaults to the `free` tier with a quota of 5 active (non-terminated) agents. Until the `company_tiers` table is deployed (1.7 TIER-SCHEMA migration), the check stays dormant and creation is unlimited. Documented in `docs/myrmidon/guides/company-agent-quota.md` (+ RU) and the wiki (Agents and roles).
