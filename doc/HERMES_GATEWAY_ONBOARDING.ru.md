# Руководство по подключению Hermes Gateway

Инструкции по настройке и использованию шлюзового адаптера `hermes_gateway` в Myrmidon. Это аналогично пути приглашения шлюза OpenClaw, но Hermes использует общий поток приглашения/онбординга агентов вместо специфичного для OpenClaw эндпоинта приглашений.

## Выбор адаптера

Paperclip поставляется с двумя встроенными адаптерами Hermes:

- `hermes_local` запускает локальный CLI `hermes` как дочерний процесс на хосте Paperclip.
- `hermes_gateway` обращается к уже запущенному серверу API Hermes по протоколу HTTP/SSE.

Для нормального использования установка Adapter manager не требуется. Adapter manager нужен только тогда, когда вы намеренно устанавливаете внешний пакет `@myrmidon/hermes-paperclip-adapter`, чтобы переопределить или подменить встроенный адаптер при разработке пакета Hermes. Если внешнее переопределение приостановлено или удалено, Paperclip восстанавливает встроенный адаптер `hermes_local` / `hermes_gateway`.

## Требуемые учетные данные

Различайте следующие учетные данные:

- Ключ провайдера инференса Hermes: укажите хотя бы один ключ провайдера, например `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` или `MISTRAL_API_KEY`.
- Ключ шлюза Hermes: установите `API_SERVER_KEY` перед запуском Hermes. Paperclip сохраняет то же значение как `agentDefaultsPayload.apiKey` для вызова Hermes.
- Ключ агента Paperclip: создается после одобрения заявки на подключение и запрашивается Hermes единожды. Hermes использует этот ключ как `PAPERCLIP_API_KEY` при вызове Paperclip.

Не используйте ключ шлюза Hermes в качестве ключа агента Paperclip. Ключ шлюза Hermes аутентифицирует трафик от Paperclip к Hermes; полученный ключ Paperclip аутентифицирует трафик от Hermes к Paperclip.

## Запуск шлюза Hermes

Сначала установите и настройте Hermes:

```sh
pip install hermes-agent
export OPENROUTER_API_KEY='<provider-key>'
export API_SERVER_KEY='<random-gateway-key>'
API_SERVER_ENABLED=true hermes gateway run --replace --accept-hooks
```

Порт сервера API Hermes по умолчанию — `8642`. Для локального тестирования loopback Paperclip обычно может сохранять `http://127.0.0.1:8642` как URL шлюза. Для Docker, локальной сети (LAN), tailnet или reverse-proxy настроек используйте URL, доступный из процесса сервера Paperclip.

Простой HTTP принимается для loopback. Не-loopback HTTP отклоняется по умолчанию в процедуре подключения; используйте HTTPS для реальных удаленных шлюзов. Только для локальной разработки тело запроса на подключение может содержать `dangerouslyAllowInsecureRemoteHttp: true`, а smoke-скрипты задают тот же флаг через `HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1`.

## Приглашение из Paperclip

В UI доски:

1. Откройте целевую компанию.
2. Используйте кнопку добавления агента на боковой панели агентов.
3. Сгенерируйте промпт/приглашение для онбординга агента.
4. Передайте сгенерированный текст онбординга рантайму Hermes.

UI-промпт указывает Hermes на машиночитаемые эндпоинты онбординга:

- `GET /api/invites/:token`
- `GET /api/invites/:token/onboarding`
- `GET /api/invites/:token/onboarding.txt`
- `GET /api/skills/index`
- `GET /api/skills/paperclip`

Для настройки через CLI создайте и просмотрите приглашение напрямую:

```sh
npx paperclipai invite create --company-id <company-id> --payload-json '{"requestType":"agent"}'
npx paperclipai invite show <token>
npx paperclipai invite onboarding:text <token>
```

Hermes должен отправить запрос на подключение с `requestType: "agent"` и `adapterType: "hermes_gateway"`:

```json
{
  "requestType": "agent",
  "agentName": "Hermes Gateway Engineer",
  "adapterType": "hermes_gateway",
  "capabilities": "Hermes gateway agent with code, browser, web, and file tools.",
  "agentDefaultsPayload": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://127.0.0.1:3100",
    "sessionKeyStrategy": "issue"
  }
}
```

Важные роли URL:

- `agentDefaultsPayload.apiBaseUrl` — это URL шлюза Hermes, который вызывает Paperclip.
- `agentDefaultsPayload.paperclipApiUrl` — это базовый URL Paperclip, который Hermes может вызывать после одобрения и получения ключа.
- `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` — инжектируемые значения рантайма для вызовов API Paperclip со стороны Hermes после одобрения агента.

## Команды Telegram `/model` и `/think`

Для агентов с адаптером `hermes_gateway`, взаимодействующих через Telegram:

- **Команда `/model`**: Отображает каталог моделей LLM-шлюза. Если шлюз отвечает, используется список, разрешенный ключом агента через `/v1/models`, иначе применяется каталог доски. Ответ указывает источник, группирует модели по семействам провайдеров (`dashscope-*`, `zai-*`, `nous-*`), держит модель карточки и резервные варианты наверху и учитывает лимит в 30 моделей.
- **Применение профиля при переопределении**: Запись переопределения `/model` или `/think` немедленно применяет профиль агента через `applyBotContainerNow` (`force: true`) без перезапуска контейнера. При сбое применяется откат к прежнему значению с указанием причины. Если среда bot-containers отсутствует, результат фиксируется как `not_applicable` (не является ошибкой).
- **Валидация уровня размышлений `/think`**: Проверяет выбранный уровень усилий по `effortsForModel` (например, модели GLM принимают `low`, `high`, `max`). Неподдерживаемые уровни отклоняются с указанием допустимых вариантов.
- **Локализованные отказы**: Сообщения об отказе включают тип адаптера и причину на языке пользователя в чате.

### Примеры использования

- **Переключение модели через Telegram**:
  ```text
  /model
  ```
  Шлюз возвращает список доступных моделей с группировкой по семействам для просмотра или выбора модели в сессии агента.
- **Настройка уровня размышлений**:
  ```text
  /think high
  ```
  Устанавливает уровень усилий рассуждения для поддерживаемых моделей (например, модели GLM принимают `low`, `high`, `max`), проверяет уровень по политике модели и немедленно применяет переопределение профиля.

## Одобрение и получение ключа

После того как Hermes отправит запрос на подключение:

1. В Paperclip просмотрите ожидающую заявку на подключение агента.
2. Одобрите ее через UI доски или используя CLI:

   ```sh
   npx paperclipai join list --company-id <company-id> --status pending_approval
   npx paperclipai join approve <request-id> --company-id <company-id>
   ```

3. Hermes запрашивает одноразовый ключ API агента:

   ```sh
   npx paperclipai join claim-key <request-id> --claim-secret <secret>
   ```

4. Сохраните полученный ключ Paperclip в состоянии рантайме или секретах Hermes. Секрет запроса и полученный ключ конфиденциальны и не должны размещаться в комментариях к тикетам, логах или тексте промптов.

После получения ключа создайте задачу, назначенную на нового агента Hermes gateway, и разбудите его через стандартный путь heartbeat Paperclip.

## Локальная дымовая проверка

Для проверки свежего шлюза Hermes на базе Docker и сквозного подключения/запуска Paperclip используйте:

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
pnpm smoke:hermes-gateway-e2e
```

Дымовая проверка выполняет:
- сборку свежего контейнера шлюза Hermes;
- инициализацию минимальной несекретной конфигурации моделей Hermes;
- передачу ключей провайдеров из окружения хоста без их вывода;
- проверку `/health`, `/v1/capabilities`, `/v1/runs`, SSE и останова Hermes;
- создание и одобрение приглашения агента Paperclip;
- подключение в качестве `hermes_gateway`;
- пробуждение агента по тестовой задаче;
- удаление тестовых состояний Paperclip и Docker при успехе.

Если шлюз Hermes уже запущен и вам нужно проверить только приглашение и сохраненную конфигурацию адаптера, используйте вспомогательный скрипт подключения:

```sh
API_SERVER_ENABLED=true API_SERVER_KEY='<gateway-key>' hermes gateway run --replace --accept-hooks

PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642 \
HERMES_GATEWAY_API_KEY='<gateway-key>' \
pnpm smoke:hermes-gateway-join
```

Подробнее см. [HERMES_GATEWAY_SMOKE.md](./HERMES_GATEWAY_SMOKE.md) для Docker Desktop, Linux, Docker в той же сети, локальных сетей (LAN) и reverse-proxy / TLS окружений.

## Точки входа для установки

Используйте следующие точки входа в зависимости от того, кто выполняет настройку:

- UI доски: кнопка добавления агента на боковой панели агентов с последующей генерацией промпта онбординга агента.
- API приглашений: `GET /api/invites/:token/onboarding.txt` для инструкций по настройке в стиле llm.txt.
- CLI-поток приглашений: `npx paperclipai invite create`, `invite show`, `invite onboarding:text`, `join approve` и `join claim-key`.
- Smoke-помощники: `pnpm smoke:hermes-gateway-e2e` для проверки свежего состояния в Docker и `pnpm smoke:hermes-gateway-join` для уже запущенного шлюза.
- Внешнее переопределение для разработки адаптера: Adapter manager может установить `@myrmidon/hermes-paperclip-adapter` в качестве внешнего переопределения, однако обычным операторам следует использовать встроенные адаптеры `hermes_local` и `hermes_gateway`.
