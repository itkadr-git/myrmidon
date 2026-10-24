---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Shared scoped secret-ref resolver for instance settings

- Instance-level settings can now take their value from a secret reference instead of a process
  environment variable. The reference is a binding on an existing secret; the value is resolved
  server-side through the secrets service, only for the consumers a setting names, and is masked
  in logs. An emergency environment variable still wins when it is set.
- New instance-admin API under `/api/instance/secret-settings`: list status, set or clear the
  reference, and a dry-run migration plan that reports presence flags and never values.
- The E2 secret coverage matrix records the disposition of the secret-provider names: credentials
  that open the store (AWS keys, master key) stay environment-only; region, endpoint, prefix and
  similar names are not secrets.
- Settings, General (and Settings, System in the new UI) lists these settings with a secret picker
  and a remove button, plus a dry-run migration check. The migration endpoint applies nothing
  unless the request says `apply: true`; it never returns a value.

## changelog-ru

### Общий resolver ссылок на секреты для настроек инстанса

- Настройки уровня инстанса теперь могут брать значение из ссылки на секрет, а не из переменной
  окружения процесса. Ссылка - привязка к существующему секрету; значение разрешается на
  сервере через сервис секретов, только для потребителей, названных в настройке, и маскируется
  в логах. Аварийная переменная окружения по-прежнему имеет приоритет, если задана.
- Новый API для администратора инстанса `/api/instance/secret-settings`: статус, установка и
  снятие ссылки и пробный план миграции, который показывает только признаки наличия, не значения.
- Матрица покрытия секретов E2 фиксирует решение по именам провайдера секретов: ключи, которыми
  открывается само хранилище (ключи AWS, мастер-ключ), остаются только в окружении; регион,
  endpoint, префикс и подобное секретами не являются.
- В Настройки, Общие (и Настройки, Система в новом интерфейсе) эти настройки выводятся с выбором
  секрета и кнопкой снятия, плюс пробная проверка миграции. Эндпоинт миграции ничего не применяет,
  пока в запросе нет `apply: true`, и никогда не возвращает значение.
