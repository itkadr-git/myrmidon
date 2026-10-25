---
divergence-section: Трек 1 — эксплуатация и надёжность
---

## changelog-en

### SWARM claim expiry provenance (1.6.6)

- Swarm claims now record whether they came from automatic matching or checkout. Expiry clears an assignee only for a released automatic-match claim that is still the current lease; legacy rows with unknown provenance remain assigned. Added a nullable migration and embedded regression coverage for unknown provenance.

## changelog-ru

### Происхождение аренды SWARM при истечении (1.6.6)

- Для захватов SWARM сохраняется источник: автоподбор или checkout. Истечение снимает назначение только для освобождённой автоматической аренды, которая всё ещё актуальна; старые записи с неизвестным происхождением не снимают назначение. Добавлены nullable-миграция и embedded-регрессионный тест.
