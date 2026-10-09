---
---

## changelog-en
### A Telegram endpoint leaves the setup wizard after its first real delivery (1.6.5 F-10)

- A Telegram endpoint that was still in the setup wizard (`status=verifying`, `setup.step` not `complete`) now completes the wizard on its own, without the manual "test" click: the first publication the Telegram API accepts moves `setup.step` to `complete` and the endpoint status to `active` in the same transaction that saves the delivery receipt.
- The update re-checks the live row (status and runtime generation), so a concurrent reconnect or an already-completed setup makes it a no-op; the endpoint keeps the wizard state when the send fails and completes on the first successful retry.
- The completion mirrors the manual "test" step exactly (tool connection activated, health `Connected`), and a manual completion request against an already-active Telegram endpoint now returns the endpoint instead of a 409 conflict.

## changelog-ru

### Telegram-эндпоинт выходит из мастера настройки после первой реальной доставки (1.6.5 F-10)

- Telegram-эндпоинт, который всё ещё был в мастере настройки (`status=verifying`, `setup.step` не `complete`), теперь завершает мастер сам, без ручного нажатия «тест»: первая публикация, которую Telegram API принял, переводит `setup.step` в `complete`, а статус эндпоинта — в `active`, в той же транзакции, что сохраняет квитанцию доставки.
- Обновление перепроверяет живую строку (статус и поколение рантайма), поэтому параллельное переподключение или уже завершённая настройка делают шаг пустым операцией; при сбое отправки эндпоинт остаётся в мастере и завершает его при первом успешном повторе.
