---
divergence-section: Трек 1 — платформа
---

## changelog-en

### The licensing screen honours the vendor's signed deny-list of revoked licenses

- A license may now carry an optional signed `id`; licenses without it verify as before.
- If a file `license.deny.json` signed by a trusted issuer key lists a license's `id`,
  `instance_id` or `kid`, the module status shows it as invalid with reason `revoked`.
  The file lives next to `license.key` (override `MYR_LICENSE_DENY_PATH`), is re-read on every
  request, and an absent, broken or foreign-signed file revokes nobody (a warning is logged).
  A list with a `serial` lower than the highest one seen is rejected; the highest serial is kept
  next to the license (`MYR_LICENSE_DENY_STATE_PATH`).

## changelog-ru

### Экран лицензирования учитывает подписанный список отзыва лицензий вендора

- Лицензия может нести необязательное подписанное поле `id`; лицензии без него проверяются как раньше.
- Если файл `license.deny.json`, подписанный доверенным ключом выдачи, перечисляет `id`,
  `instance_id` или `kid` лицензии, статус модуля показывает её недействительной с причиной `revoked`.
  Файл лежит рядом с `license.key` (путь меняется `MYR_LICENSE_DENY_PATH`), перечитывается на каждом
  запросе; нет файла, битый файл или чужая подпись никого не отзывают (в журнал пишется предупреждение).
  Список с `serial` меньше виденного отвергается; наибольший serial хранится рядом с лицензией
  (`MYR_LICENSE_DENY_STATE_PATH`).
