---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Telemetry export token can use a secret reference

- The feedback/telemetry export token can now be taken from a bound secret reference instead of a process environment variable. The value is resolved on the server only, per use, and an emergency environment variable still wins when set.
- Credentials the board needs before it can reach the secret store (session and agent token signing, workspace handoff, tenant and health tokens) stay environment-only by design; the E2 coverage matrix records the reason for each.

## changelog-ru

### Токен выгрузки телеметрии может браться из ссылки на секрет

- Токен выгрузки обратной связи и телеметрии теперь можно брать из привязанной ссылки на секрет, а не из переменной окружения процесса. Значение разрешается только на сервере, при каждом использовании; аварийная переменная окружения по-прежнему имеет приоритет.
- Учётные данные, нужные доске до доступа к хранилищу секретов (подпись сессий и токенов агентов, handoff рабочих пространств, токены тенанта и здоровья), по замыслу остаются только в окружении; матрица покрытия E2 фиксирует причину для каждого.
