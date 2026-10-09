## changelog-en

### Bot disk: integration test of the whole mechanism and the canary / shutdown runbook (1.6.5 BOT-DISK-H)

- New `scripts/myrmidon/bot-runtime/bot-disk-integration.test.mjs` runs the botd
  loop, rules, archive module and the `myr-ws` inventory/close/restore together
  on real git: closing grace, clean-pushed removal, archive before removal of
  unpushed work, restore, fail-safe with the board down, orphan grace, drift
  prune, and a failing archive that keeps the copy.
- New runbook `docs/myrmidon/bot-disk-canary-runbook.md` (with a Russian
  version): what the test covers and what only a stand can, the canary on three
  development bots with its measurements, the stop switch, and the shutdown of
  the host-side cleanup scripts with preconditions, rollback and the 14-day
  deletion check.
- No runtime behaviour changes.

## changelog-ru

### Диск ботов: интеграционный тест всего механизма и регламент канарейки и выключения (1.6.5 BOT-DISK-H)

- Новый `scripts/myrmidon/bot-runtime/bot-disk-integration.test.mjs` гоняет цикл
  botd, правила, модуль архива и инвентарь/close/restore `myr-ws` вместе на
  настоящем git: grace закрытия, удаление чистой запушенной копии, архив перед
  удалением незапушенной работы, restore, fail-safe при недоступной доске, срок
  сироты, prune дрейфа и упавший архив, сохраняющий копию.
- Новый регламент `docs/myrmidon/bot-disk-canary-runbook.md` (есть русская
  версия): что закрывает тест и что только стенд, канарейка на трёх dev-ботах с
  замерами, выключатель, выключение хост-скриптов с условиями, откатом и
  проверкой удаления через 14 суток.
- Поведение в рантайме не меняется.
