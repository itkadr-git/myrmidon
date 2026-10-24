## changelog-en

### Chat flakes stabilization: durable callback order and credential-lease isolation (OPE-6916)

- The pending receipt-reaction sweep treats a busy credential-mutation lease
  (409 `chat_endpoint_credentials_busy`) as a skip for this pass: the refusal
  is transient by design and the action stays retryable, so a leaked lease
  from a finished test case (or a slow concurrent holder) can no longer fail
  an unrelated caller.
- The integration suite now deletes fixture-company `chat_endpoint_leases`
  rows in `afterEach`, so a service that died while holding a credential or
  conversation lease cannot make the next case wait out the 10s acquire
  window and throw.
- The runner transport test asserts the steady-state socket read timeout
  within kernel-tick tolerance (250–260 ms) instead of requiring tick-exact
  equality: `SO_RCVTIMEO` round-trips in jiffies, so a loaded CI runner
  (HZ=250 → 4 ms granularity) legitimately reports 252 ms for the 250 ms
  runtime timeout.

## changelog-ru

### Стабилизация флейков чата: детерминированный порядок callback'ов и изоляция credential-lease (OPE-6916)

- Свип pending receipt-реакций считает занятый credential-mutation lease
  (409 `chat_endpoint_credentials_busy`) пропуском текущего прохода: отказ
  транзиентен по замыслу, действие остаётся retryable, поэтому утёкший lease
  из завершённого тест-кейса больше не валит несвязанный вызов.
- Интеграционный suite теперь удаляет строки `chat_endpoint_leases` компаний
  фикстур в `afterEach`: сервис, погибший с удерживаемым lease, не сможет
  заставить следующий кейс ждать 10 с окна acquire и бросить 409.
- Тест runner-транспорта проверяет steady-state read timeout с допуском
  на тик ядра (250–260 мс) вместо точного равенства: `SO_RCVTIMEO`
  округляется до jiffies, и на загруженном CI-раннере (HZ=250 →
  гранулярность 4 мс) законный результат для 250 мс — например 252 мс.
