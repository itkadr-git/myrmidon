---

---

## changelog-en

### ARCH-GUARD: architecture invariants in the repository and checked in CI (OPE-6856)

- `docs/architecture/` holds the invariants catalog (INV-0..INV-13) and the ADR
  records of the product decisions from the decision registry.
- `scripts/myrmidon/ci/arch-invariants-gate.mjs` turns INV-10..INV-13 into CI
  checks (no automatic wake-up without a task, one swarm queue ordering, no
  pilot fields, unique and gapless migration numbers); dependency rules are in
  `.dependency-cruiser.cjs`. The pull request template asks which ADR a change
  implements or amends.
- Dependency-blocked idle pickup now binds its wake-up to the task whose
  dependency release made the agent eligible, so the automatic wake is auditable.

## changelog-ru

### ARCH-GUARD: архитектурные инварианты в репозитории и проверка в CI (OPE-6856)

- `docs/architecture/` содержит каталог инвариантов (INV-0..INV-13) и ADR по
  продуктовым решениям из реестра решений.
- `scripts/myrmidon/ci/arch-invariants-gate.mjs` превращает INV-10..INV-13 в
  проверки CI (нет автоматической побудки без задачи, одна реализация порядка
  очереди роя, нет пилотных полей, номера миграций уникальны и без дыр);
  правила зависимостей — в `.dependency-cruiser.cjs`. Шаблон PR спрашивает, какой
  ADR реализует или меняет изменение.
- Подхват простаивающего агента после снятия зависимости теперь привязывает
  побудку к задаче, чьё снятие зависимости сделало агента подходящим, поэтому
  автоматическая побудка прослеживается.
