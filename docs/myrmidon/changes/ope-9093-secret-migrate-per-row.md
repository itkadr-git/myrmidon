---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Per-row secret migration apply

- Applying the secret-ref migration is now independent per setting: a failure on one row no longer
  loses the rows already bound or their audit entries. Each row is audited right after it is bound;
  if the audit or the binding fails, that row is rolled back (binding cleared, newly created secret
  deleted) and reported as an error with a code, never with a value.
- Re-running the migration after a reference was cleared reuses the secret created earlier for the
  same setting. A secret that holds the migration name but belongs to something else is reported as
  a conflict and left untouched.

## changelog-ru

### Применение миграции ссылок на секреты по строкам

- Применение миграции ссылок на секреты теперь независимо для каждой настройки: сбой одной строки
  больше не теряет уже привязанные строки и их записи аудита. Каждая строка пишется в аудит сразу
  после привязки; если упали аудит или привязка, строка откатывается (привязка снимается, только
  что созданный секрет удаляется) и возвращается как ошибка с кодом, без значения.
- Повторный запуск после снятия ссылки переиспользует секрет, созданный ранее для той же настройки.
  Секрет с именем миграции, который принадлежит другому, возвращается как конфликт и не меняется.
