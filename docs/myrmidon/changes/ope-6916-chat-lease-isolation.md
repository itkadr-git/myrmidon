## changelog-en

### Chat test flake: credential-lease isolation (OPE-6916)

- The pending receipt-reaction sweep treats a busy credential-mutation lease
  (409 `chat_endpoint_credentials_busy`) as a skip for this pass: the refusal
  is transient by design and the action stays retryable, so a leaked lease
  from a finished test case (or a slow concurrent holder) can no longer fail
  an unrelated caller.
- The chat-channels integration suite now deletes fixture-company
  `chat_endpoint_leases` rows in `afterEach`, so a service that died while
  holding a lease cannot make the next case wait out the 10s acquire window.

## changelog-ru

### Флейк тестов чата: изоляция credential-lease (OPE-6916)

- Свип pending receipt-реакций считает занятый credential-mutation lease
  (409 `chat_endpoint_credentials_busy`) пропуском текущего прохода: отказ
  транзиентен по замыслу, действие остаётся retryable, поэтому утёкший lease
  из завершённого тест-кейса больше не валит несвязанный вызов.
- Интеграционный suite чата удаляет строки `chat_endpoint_leases` компаний
  фикстур в `afterEach`: сервис, погибший с удерживаемым lease, не заставит
  следующий кейс ждать 10 с окна acquire.
