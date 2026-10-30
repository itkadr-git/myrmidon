---
divergence-section: Трек 1 — платформа
---

## changelog-en

### CI: merge queue candidates run the full tier (OPE-8531)

- Ordinary pull requests run the fast tier; the full tier runs when the `review-approved` or `full-ci` label is set (the label starts a run on the same head), on the merge queue candidate (`merge_group`, if a queue is enabled), and on `main`.

## changelog-ru

### CI: кандидат merge queue идёт полным уровнем (OPE-8531)

- Обычные PR проходят быстрый уровень; полный уровень запускается при постановке метки `review-approved` или `full-ci` (метка запускает прогон на том же коммите), на кандидате merge queue (`merge_group`, если очередь включена) и на `main`.
