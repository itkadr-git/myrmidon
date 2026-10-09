## changelog-en
### A Telegram endpoint leaves the setup wizard on its first successful delivery (1.6.5 F-10)

- A Telegram endpoint that is still waiting for the wizard's test step (`status=verifying`, `setup.step=test`) now settles on its own, without the manual "test" click: the first publication the Telegram API accepts moves `setup.step` to `complete` and the endpoint status to `active` in the same transaction that saves the delivery receipt, and activates the endpoint's tool connection in that same save.
- The completion update re-checks the live row (status plus runtime generation) with `.returning()`; the tool connection is only activated when the endpoint actually flipped to active, so a concurrent reconnect that empties the update leaves endpoint and connection untouched (no wiped `lastError`, no divergent health). When the send fails, the endpoint keeps the wizard state and completes on the first successful retry.
- A manual test request against an already-active, completed Telegram endpoint returns the endpoint as an idempotent no-op instead of a 409 conflict.

## changelog-ru
### Telegram-эндпоинт выходит из мастера настройки после первой успешной доставки (1.6.5 F-10)

- Telegram-эндпоинт, который всё ещё ждёт шага теста мастера (`status=verifying`, `setup.step=test`), теперь завершает мастер сам, без ручного нажатия «тест»: первая публикация, которую Telegram API принял, переводит `setup.step` в `complete`, а статус эндпоинта — в `active`, в той же транзакции, что сохраняет квитанцию доставки; в этом же сохранении активируется tool-подключение эндпоинта.
- Обновление завершения перепроверяет живую строку (статус и поколение рантайма) через `.returning()`; tool-подключение активируется только если эндпоинт действительно перешёл в active, поэтому параллельное переподключение, обнулившее обновление, не трогает ни эндпоинт, ни подключение (не стирается `lastError`, нет рассогласования здоровья). При сбое отправки эндпоинт остаётся в мастере и завершает его при первом успешном повторе.
- Ручной запрос теста для уже активного и завершённого Telegram-эндпоинта возвращает эндпоинт как идемпотентную пустую операцию, а не 409-конфликт.
