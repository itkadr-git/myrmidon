---
divergence-section: Трек 1 — платформа
---

## changelog-en

### CI: merge queue candidates run the full tier (OPE-8531)

- Ordinary pull requests run the fast tier; the full tier is required before landing and runs on the merge queue candidate (`merge_group`), on `full-ci` labelled PRs, and on `main`.

## changelog-ru

### CI: кандидат merge queue идёт полным уровнем (OPE-8531)

- Обычные PR проходят быстрый уровень; полный уровень обязателен перед вливанием и запускается на кандидате merge queue (`merge_group`), на PR с меткой `full-ci` и на `main`.
