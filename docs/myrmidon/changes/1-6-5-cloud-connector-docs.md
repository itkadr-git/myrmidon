## changelog-en

### Cloud storage docs: connector guide links and the Russian settings section (CLOUD-CONNECTOR)

- The cloud-storage bullet in the root README now points at
  [docs/myrmidon/guides/cloud-connector.md](docs/myrmidon/guides/cloud-connector.md) — the guide of
  the connector module — instead of the 1.3 `cloud-files` guide, which documents the temporary
  Microsoft 365 file-and-mail service for bots and carries none of the `MYRMIDON_CLOUD_*` variables.
- The Russian settings registry gains the connector section the English one already had, so an owner
  reading `SETTINGS.ru.md` finds the provider client credentials and the callback base address.

## changelog-ru

### Документация облаков: ссылки на гайд коннектора и русский раздел настроек (CLOUD-CONNECTOR)

- Пункт про облачные хранилища в корневом README теперь ведёт на
  [docs/myrmidon/guides/cloud-connector.md](docs/myrmidon/guides/cloud-connector.ru.md) — гайд
  модуля коннектора, а не на гайд 1.3 про службу `cloud-files` (файлы и почта Microsoft 365 для
  ботов), в котором нет ни одной переменной `MYRMIDON_CLOUD_*`.
- В русский реестр настроек добавлен раздел коннектора, который уже был в английском: владелец,
  читающий `SETTINGS.ru.md`, находит там клиентские данные провайдеров и базовый адрес callback.

## settings-ru-new

<!-- after: Настройки в записи агента (не переменные окружения) -->
### CLOUD-CONNECTOR — коннектор облачных хранилищ (1.4)

Модуль «Облака» (`server/src/myrmidon/cloud-connector/`, контракт —
`packages/shared/src/myrmidon-cloud-connector.ts`). Состояние коннектора лежит в
`instance_settings.general.myrmidonCloudConnector`, а токен владельца — нет: это секрет компании в
хранилище секретов инстанса (`myrmidon-cloud-<провайдер>`), его пишет поток подключения и
перезаписывает каждое автоматическое обновление. Провайдер, для которого здесь нет клиентских
данных, подключить нельзя; папка, у компании которой нет подключённого аккаунта, отвечает на вызов
облака `409 not connected`.

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE` | CLOUD-CONNECTOR | не задана (выкл.) | Публичный базовый адрес панели, на который провайдеры возвращают владельца (например `https://board.example.com`, без завершающего `/`). Callback коннектора — `<база>/api/myrmidon/cloud-connector/oauth/callback`, его надо зарегистрировать в OAuth-приложении каждого провайдера | Не задана или пуста — адрес callback остаётся относительным, и запуск подключения отвечает `409 the connector callback address is not configured`; поверхность папок, грантов и журнала продолжает работать |
| `MYRMIDON_CLOUD_ONEDRIVE_CLIENT_ID` | CLOUD-CONNECTOR | не задана (выкл.) | OAuth client id приложения Microsoft (OneDrive). Запрашиваемые области: `Files.ReadWrite.All offline_access User.Read`; аккаунт — личный аккаунт Microsoft (`consumers`) | Не задана — OneDrive подключить нельзя (`409 not configured`); всё остальное работает |
| `MYRMIDON_CLOUD_ONEDRIVE_CLIENT_SECRET` | CLOUD-CONNECTOR | не задана | Client secret того же приложения. Читает только сервер; в ответе и в журнале не появляется | — |
| `MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_ID` | CLOUD-CONNECTOR | не задана (выкл.) | OAuth client id приложения Google Drive. Запрашиваемая область: `https://www.googleapis.com/auth/drive` с `access_type=offline` (коннектор ограничивает каждый вызов выданной папкой) | Не задана — Google Drive подключить нельзя; сам провайдер зарегистрирован по умолчанию |
| `MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_SECRET` | CLOUD-CONNECTOR | не задана | Client secret того же приложения | — |
| `MYRMIDON_CLOUD_YANDEX_DISK_CLIENT_ID` | CLOUD-CONNECTOR | не задана (выкл.) | OAuth client id приложения Яндекс Диска. Запрашиваемые области: `cloud_api:disk.read cloud_api:disk.write`; Яндекс не поддерживает PKCE, поэтому он не отправляется | Не задана — Яндекс Диск подключить нельзя; сам провайдер зарегистрирован по умолчанию |
| `MYRMIDON_CLOUD_YANDEX_DISK_CLIENT_SECRET` | CLOUD-CONNECTOR | не задана | Client secret того же приложения | — |

Агентская поверхность: коннектор отдаёт облачные инструменты и по MCP —
`POST <доска>/api/mcp/cloud-tools` (JSON-RPC: `initialize`, `tools/list`, `tools/call` с
`cloud_list`, `cloud_search`, `cloud_read`, `cloud_download`, `cloud_upload`, `cloud_move`). Своей
переменной ей не нужно: вызывающий — ключ прогона самого агента, и каждый вызов ограничен папками,
выданными этому агенту; отказы названы. Чтобы агенты увидели инструменты, зарегистрируйте адрес
доски как tool connection и назначьте его — сам эндпоинт включён всегда.

Две вещи, на которые опирается агентская поверхность и которые стоит знать, когда вызов отклонён.
Грант «касте» совпадает с ролью агента на доске (`agents.role`), читаемой на каждом вызове; у
агента с пустой ролью касты нет, и совпадают только гранты «этому агенту» и «всем». А имя корня
`personal` зарезервировано: оно всегда означает личную папку вызывающего агента, которую коннектор
создаёт при первом обращении и выдаёт `rw` только этому агенту. Владелец не может завести папку с
таким именем (`400 reserved`), а агенту, который её просит, объясняют, что делать, когда ответ
неочевиден: у его компании нет подключённого аккаунта или подключено несколько облаков (`409` с
перечислением провайдеров).