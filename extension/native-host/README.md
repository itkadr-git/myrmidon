# Sign native host (part H, OPE-3392)

Локальный Windows-хелпер подписи: native messaging host для расширения Myrmidon
(часть C, OPE-3388). Выполняет подпись по команде бота через абстракцию
мидлвари токена; PIN и ключ никогда не покидают машину клиента и не проходят
через наши серверы и модель.

Дизайн-записка кейса: тикет OPE-3383, §4.5 (подпись), §2 (компонент 4).

## Архитектура и границы доверия

```
бот → gateway (browser.sign) → расширение → native messaging → этот хелпер
     → мидлварь токена (CryptoPro и подобные) → подпись → {ok,hash} → журнал
```

- Единственный канал хелпера — stdio, который открывает браузер. Сетевых
  интерфейсов нет: ни HTTP, ни WebSocket, ни listening-сокетов.
- Браузер запускает host только при совпадении origin из манифеста
  `allowed_origins` с ID расширения — регистрация в реестре (`install/`)
  пинит ровно один extension ID.
- PIN живёт в Windows Credential Store (CredRead/CredWrite API, не в файле)
  либо в самой мидлвари токена. Через native messaging мост PIN не идёт
  никогда: по мосту ходят только команда ({actionType, documentRef, document})
  и результат ({ok, hash} | {ok:false, error}).
- Хелпер не хранит документ: documentRef разрешается в байты расширением
  (часть D решает, отправлять байты целиком или дайджест — контракт
  `DocumentPayload` поддерживает оба варианта).

## Протокол (контракт с частью D, OPE-3389)

Команда:

```json
{ "type": "sign", "id": 1, "actionType": "sign", "documentRef": "workspace/docs/tender.pdf",
  "document": { "kind": "bytes", "bytesBase64": "..." } }
```

или `{ "kind": "digest", "digestHex": "<sha-256 hex>" }` (расширение
захэшировало само). Ответ:

```json
{ "type": "sign_result", "id": 1, "result": { "ok": true, "hash": "<sha-256 hex>" } }
```

либо `{ "ok": false, "error": "invalid_request|unknown_action_type|unsupported_payload|pin_unavailable|middleware_error|cancelled" }`.

`actionType` — закрытый enum (`sign`, `sign_and_submit`, `sign_attachment`);
всё вне enum отбрасывается до вызова мидлвари (red-side тесты). Сообщения без
валидной структуры молча дропаются — ответить на неизвестный shape нельзя,
исполнять нельзя.

## Состав

- `src/protocol.ts` — типы/валидаторы протокола, enum actionType.
- `src/wire.ts` — формат Chrome native messaging (4-байтовый LE-префикс длины).
- `src/middleware.ts` — абстракция `sign(document)` + мок-мидлварь для стенда ч. F.
- `src/pin.ts` — стратегии PIN: credential store / «мидлварь хранит сама»;
  fail-closed при недоступности PIN (никаких фолбэков в файл/промпт).
- `src/credstore.ts` — привязка Windows Credential Store (CredRead/CredWrite).
- `src/host.ts` — цикл приёма команд, диспетчеризация, ответ с хэшем;
  `disabled` — зеркалирование экстренного выключения (fail-closed).
- `src/index.ts` — точка входа; режим `mock` для стенда, `middleware` — место
  реальной интеграции с мидлварью клиента (при подключении, не в этой части).
- `install/install-host.ps1` — регистрация native messaging host
  (HKCU\Software\Google\Chrome\NativeMessageHosts или Edge-эквивалент),
  манифест с `allowed_origins` ровно на один extension ID.
- `install/host.cmd` — лаунчер хоста для манифеста.
- `test/` — unit-тесты без реального Windows (мок native messaging),
  включая `red-side.test.ts` (атаки: внедрение actionType, контрабанда PIN,
  framing-бомба, чужие shape сообщений).

## Запуск и проверка

```
cd extension/native-host
npm install          # typescript + @types/node
npm test             # node --test --experimental-strip-types test/
npx tsc --noEmit     # typecheck
```

## Установка на ПК клиента (Windows)

```powershell
# сборка: tsc (dist/index.js), затем
powershell -ExecutionPolicy Bypass -File install\install-host.ps1 `
  -ExtensionId <32-char-extension-id> -HostPath <abs>\install\host.cmd
```

Скрипт валидирует формат extension ID и существование host-пути, пишет
манифест в `%LOCALAPPDATA%\Myrmidon\SignHelper` и ключ реестра
`HKCU:\...\NativeMessageHosts\com.myrmidon.sign-helper`.

## Что не в этой части

- Реальная интеграция с мидлварью клиента (CryptoPro и подобные) — при
  подключении клиента; интерфейс и fail-closed поведение зафиксированы здесь.
- UI подтверждения ручного режима — в расширении (ч. C/D); хелпер получает
  команду только после подтверждения.
- Настройки авто/ручного режима и журнал подписей — в gateway (ч. B/D).
