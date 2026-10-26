---
divergence-section: Брендинг
---

## changelog-en

### Knowledge UI: ADR-0008 seed title no longer says the vendor name (DEBRAND, OPE-9333)

- The seeded knowledge item `decisions/2026-09-27-no-upstream` (ADR-0008, shown
  in the Knowledge UI decisions folder) is now titled "В апстрим не отправляем",
  matching the debranded ADR-0008 record in `docs/architecture/adr/`. The
  vendor name stays only in the license/attribution and fork-history entries,
  and in the owner's verbatim quote, which are out of DEBRAND scope.
- Follow-up to the architecture-records debrand reviewed in OPE-9331 (PR #1805);
  same wording as the ADR file so the registry, the docs record and the
  Knowledge UI item agree.
- Regression coverage: `knowledge-seed.db.myrmidon.test.ts` now asserts the
  seeded item's title exactly and rejects a vendor-brand title.

## changelog-ru

### Knowledge UI: заголовок сида ADR-0008 больше не называет вендора (DEBRAND, OPE-9333)

- Сид-запись базы знаний `decisions/2026-09-27-no-upstream` (ADR-0008, видна в
  папке decisions экрана Knowledge) теперь называется «В апстрим не
  отправляем» — в той же формулировке, что и де-брендированная запись
  ADR-0008 в `docs/architecture/adr/`. Имя вендора остаётся только в
  лицензионной атрибуции, истории форка и дословной цитате владельца — это
  вне рамок DEBRAND.
- Follow-up к де-бренду архитектурных записей из ревью OPE-9331 (PR #1805):
  реестр, ADR-файл и запись в Knowledge UI теперь согласованы.
- Регрессионное покрытие: `knowledge-seed.db.myrmidon.test.ts` теперь проверяет
  точный заголовок сида и запрещает заголовок с брендом вендора.
