---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Application module credentials can use secret references

- The stack release check GitHub token, the tracing ClickHouse password and the browser screen-console token can now be taken from a bound secret reference instead of a process environment variable. The value is resolved on the server only, per use, so a changed or revoked reference applies without a restart. An emergency environment variable still wins when set.

## changelog-ru

### Учётные данные прикладных модулей могут браться из ссылки на секрет

- Токен GitHub для проверки релизов стека, пароль ClickHouse для трассировки и токен консоли экрана браузера теперь можно брать из привязанной ссылки на секрет, а не из переменной окружения процесса. Значение разрешается только на сервере, при каждом использовании, поэтому смена или отзыв ссылки действуют без перезапуска. Аварийная переменная окружения по-прежнему имеет приоритет, если задана.
