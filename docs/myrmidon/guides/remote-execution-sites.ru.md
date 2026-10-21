# Удалённые площадки исполнения: контракт site-agent и руководство оператора

> English version: [remote-execution-sites.md](remote-execution-sites.md)

Документ фиксирует архитектуру взаимодействия, HTTP/JSON проводной контракт, конечный автомат состояний здоровья/отказов и регламент развёртывания удалённых площадок исполнения (remote sites) в релизе Myrmidon 1.6.6 (контекст OPE-7605).

---

## 1. Архитектура и принципы управления

### 1.1 Односторонний контур управления

Доска на сервере `vm-core` остаётся **единственным контуром управления** (`target-architecture.md` §0):
- Доска хранит базу данных, очередь задач, планировщик, секреты и аудит-лог.
- Удалённая площадка (например, `myr-vm1`) выполняет роль доверенной исполнительной среды.
- **Инвариант однонаправленности**: соединение инициируется исключительно от центра `vm-core` к удалённой площадке через изолированный туннель IPsec / WireGuard. У агента площадки (`fleetd`) нет прав доступа к БД доски, токенов администратора или обратных ключей в сторону `vm-core`.
- Агент площадки (`fleetd`) слушает внутренний интерфейс (например, `fleetd.internal:9100`), управляет локальным сокетом `/var/run/docker.sock` на своём хосте и исполняет команды строго в рамках таблицы зачисления (`bots[]`), лимитов ресурсов и allowlist образов по дайджестам.

```
+-----------------------------------------------------------------------+
|  vm-core (Единый центр управления)                                    |
|                                                                       |
|  [Планировщик / Реконсилер]                                           |
|          |                                                            |
|          v                                                            |
|  [fleetRoutingDriver] ---> локальный dockerBotContainerDriver         |
|          |                 (dockergate /var/run/dockergate.sock)      |
|          |                                                            |
|          v (HTTP / mTLS + Bearer Token через IPsec)                   |
+----------|------------------------------------------------------------+
           |
           | Внутренняя сеть (board.internal <-> fleetd.internal)
           v
+-----------------------------------------------------------------------+
|  myr-vm1 (Удалённая площадка исполнения)                             |
|                                                                       |
|  [fleetd / site-agent] (:9100)                                        |
|          |                                                            |
|          +---> локальный /var/run/docker.sock                         |
|          +---> Контейнеры ботов: myrmidon-bot-<botKey>                |
|          +---> Корень томов: /srv/myrmidon-xfs/myrmidon-bots/         |
|          +---> Локальная память C-MEM (hindsight-work / pgvector)     |
+-----------------------------------------------------------------------+
```

---

## 2. Проводной контракт site-agent (API v1)

Каждый вызов передаётся по HTTP с заголовком:
`Authorization: Bearer <SITE_TOKEN>`.
Тела запросов и ответов кодируются в JSON (`Content-Type: application/json; charset=utf-8`).

### 2.1 Каталог маршрутов

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/v1/health` | Снимок здоровья, текущая эпоха (epoch), ёмкость и активные lease |
| `GET` | `/v1/bots` | Список всех контейнеров на площадке |
| `POST` | `/v1/bots` | Создать контейнер по спецификации (в остановленном состоянии) |
| `GET` | `/v1/bots/{botKey}/status` | Статус, состояние контейнера, хеши и выделенный `gatewayPort` |
| `POST` | `/v1/bots/{botKey}/template-drift` | Сверка параметров контейнера со спецификацией |
| `PUT` | `/v1/bots/{botKey}/profile` | Запись скомпилированных файлов профиля (`0600`/`0644`) на диск |
| `POST` | `/v1/bots/{botKey}/recreate` | Пересоздание контейнера при обнаружении template drift |
| `POST` | `/v1/bots/{botKey}/start` | Запуск контейнера (только после записи профиля) |
| `POST` | `/v1/bots/{botKey}/restart` | Перезапуск шлюза контейнера |
| `POST` | `/v1/bots/{botKey}/stop` | Остановка контейнера |
| `GET` | `/v1/bots/{botKey}/logs?tail=N` | Чтение ограниченного и очищенного от секретов лога |
| `POST` | `/v1/leases/claim` | Захват или продление lease выполнения с защитой от сплит-брейна |
| `POST` | `/v1/leases/release` | Освобождение lease после завершения задачи |

---

### 2.2 Схемы запросов и ответов

#### 2.2.1 `GET /v1/health`

Возвращает эксплуатационный статус площадки:

```json
{
  "siteId": "myr-vm1",
  "epoch": 14,
  "status": "healthy",
  "capacity": {
    "cpuCores": 16,
    "memoryMb": 65536,
    "diskGb": 500
  },
  "allocated": {
    "cpuCores": 4.5,
    "memoryMb": 18432,
    "pids": 768,
    "containersCount": 3
  },
  "egressCheck": {
    "ok": true,
    "timestamp": "2026-10-17T16:30:00Z"
  },
  "activeLeases": [
    {
      "executionId": "2c277a56-73f0-43da-a3a0-b18b80ffa808",
      "botKey": "work-qa",
      "leaseEpoch": 14,
      "expiresAt": "2026-10-17T16:35:00Z"
    }
  ],
  "version": "1.6.6"
}
```

Поля:
- `siteId` (строка, обязательно): Идентификатор площадки в реестре центра.
- `epoch` (целое, обязательно): Монотонно возрастающее поколение настроек / отсечки.
- `status` (строка, обязательно): Одно из `"healthy"`, `"degraded"`, `"unavailable"`, `"fenced"`, `"recovering"`.
- `capacity` (объект, обязательно): Выделенные аппаратные ресурсы площадки под ботов.
- `allocated` (объект, опционально): Сумма текущих зарезервированных ресурсов ботов.
- `egressCheck` (объект, опционально): Проверка связности до LiteLLM и памяти на `vm-core`.
- `activeLeases` (массив, опционально): Активные lease исполнения на площадке.
- `version` (строка, опционально): Версия ПО site-agent/fleetd на площадке.

#### 2.2.2 `GET /v1/bots/{botKey}/status`

Возвращает текущее состояние контейнера и сетевой порт:

```json
{
  "botKey": "work-qa",
  "state": "running",
  "image": "ghcr.io/itkadr-git/myrmidon-bot@sha256:7f9a8b1c2d3e...",
  "restartHash": "a1b2c3d4e5f6",
  "filesHash": "f6e5d4c3b2a1",
  "gatewayPort": 18642,
  "maxConcurrentRuns": 2
}
```

Поля:
- `botKey` (строка, обязательно): Ключ бота (`[a-z0-9-]`).
- `state` (строка, обязательно): `"running"`, `"stopped"`, `"missing"`, `"unhealthy"`.
- `image` (строка, опционально): Дайджест образа по sha256 (`image@sha256:...`). Использование `:latest` запрещено.
- `gatewayPort` (целое число, опционально): Номер TCP-порта, выделенный на хосте площадки для шлюза Hermes. Используется `fleetGatewayApiBaseUrl` для генерации адреса `apiBaseUrl` карточки бота.
- `restartHash` (строка, опционально): Хеш файлов конфигурации шлюза.
- `filesHash` (строка, опционально): Хеш инструкций и промптов.

#### 2.2.3 `POST /v1/bots` и `POST /v1/bots/{botKey}/recreate`

Запрос на создание или пересоздание контейнера:

```json
{
  "spec": {
    "botKey": "work-qa",
    "image": "ghcr.io/itkadr-git/myrmidon-bot@sha256:7f9a8b1c2d3e...",
    "memoryMb": 2048,
    "cpus": 1.5,
    "pidsLimit": 256,
    "network": "myrmidon-bots",
    "extraMounts": [
      {
        "source": "/srv/shared/reference-docs",
        "containerPath": "/shared/docs",
        "readOnly": true
      }
    ]
  }
}
```

Ограничения:
- `image` обязан содержать дайджест `@sha256:...`, входящий в `imageAllowlist` площадки.
- Значения `memoryMb`, `cpus`, `pidsLimit` не должны превышать квоту зачисления (`bots[]`).
- Все `extraMounts` подключаются строго read-only и только из проверенного списка хоста.

#### 2.2.4 `PUT /v1/bots/{botKey}/profile`

Запись профиля конфигурации до старта:

```json
{
  "profile": {
    "botKey": "work-qa",
    "files": [
      {
        "path": "hermes/config.yaml",
        "content": "api_server:\n  port: 8642\n",
        "mode": 420,
        "secret": false
      },
      {
        "path": "hermes/.env",
        "content": "API_SERVER_KEY=\"<redacted>\"\n",
        "mode": 384,
        "secret": true
      }
    ],
    "restartHash": "a1b2c3d4e5f6",
    "filesHash": "f6e5d4c3b2a1"
  }
}
```

Правила безопасности:
- Файлы секретов (`secret: true`) записываются на диск с маской `0600` (mode 384).
- Значения секретов никогда не возвращаются в ответах API и не логируются агентом.

#### 2.2.5 `POST /v1/leases/claim`

Захват lease исключает запуск дублей при сбоях сети:

```json
{
  "executionId": "2c277a56-73f0-43da-a3a0-b18b80ffa808",
  "botKey": "work-qa",
  "leaseEpoch": 14,
  "ttlSec": 60
}
```

Ответ при успехе:
`{"acquired": true, "leaseEpoch": 14, "expiresAt": "2026-10-17T16:31:00Z", "fenced": false}`.

Ответ при отводе (fencing):
`{"acquired": false, "leaseEpoch": 14, "expiresAt": "", "fenced": true, "reason": "site_fenced"}`.

---

## 3. Состояния площадки и обработка ошибок

### 3.1 Автомат состояний площадки

```
   +-----------+  1-2 пропуска проверок  +------------+
   |  healthy  | ----------------------> |  degraded  |
   +-----------+                         +------------+
         ^                                     |
         | проверка восстановилась             | 3 пропуска подряд (90с)
         |                                     v
   +------------+   сверка epoch        +---------------+
   | recovering | <-------------------- |  unavailable  | (draining)
   +------------+                       +---------------+
         ^                                     |
         |                                     | обрыв связи > 10м
         | промоут / снятие отвода             v
         +----------------------------- +------------+
                                        |   fenced   |
                                        +------------+
```

1. **`healthy`**: Регулярные проверки здоровья каждые 30 секунд. Ресурсы в норме. Egress доступен.
2. **`degraded`**: 1-2 кратковременных сбоя health или задержки egress. Текущие задачи продолжают выполняться, новые назначения на площадку временно приостанавливаются.
3. **`unavailable`**: 3 пропуска проверок подряд (90 секунд). Доска переводит площадку в режим `draining`. Новые прогоны не назначаются.
4. **`fenced`**: Обрыв связи более 10 минут либо ручной отвод оператором. Доска повышает `siteEpoch`, отменяя старые leases. Задачи безопасно возвращаются в очередь, исключая дубликаты. Площадка отклоняет все новые запуски.
5. **`recovering`**: Связь восстановилась. Агент сверяет запущенные контейнеры с реестром центра, останавливает потерянные процессы и после валидации возвращается в `healthy`.

---

### 3.2 Коды ошибок и причины

Все ошибки возвращаются однострочными безопасными кодами без утечки секретов и путей:

| HTTP-код | Код причины | Описание |
|---|---|---|
| `400` | `bad_bot_key` | Ключ бота содержит недопустимые символы |
| `400` | `body_not_allowed` | Некорректный JSON или неизвестные поля |
| `401` | `invalid_token` | Неверный или отсутствующий токен авторизации |
| `401` | `bad_certificate` | Сертификат клиента mTLS не подписан доверенным CA |
| `403` | `bot_not_enrolled` | Бот не занесён в таблицу зачисления `bots[]` |
| `403` | `limit_exceeds_enrollment` | Запрошенные CPU/RAM превышают квоту зачисления |
| `403` | `image_not_allowed` | Образ не закреплён дайджестом sha256 или отсутствует в allowlist |
| `403` | `mount_not_allowed` | Попытка смонтировать неразрешённый путь хоста |
| `404` | `container_missing` | Контейнер отсутствует при попытке старта/остановки |
| `409` | `lease_conflict` | Lease уже удерживается другим executionId |
| `409` | `epoch_stale` | Переданная эпоха lease устарела |
| `409` | `site_fenced` | Площадка находится в состоянии отвода |
| `429` | `capacity_exhausted` | На площадке исчерпаны физические ресурсы |
| `502` | `docker_unreachable` | Агент не может связаться с сокетом Docker |

---

## 4. Регламент развёртывания и настройки оператором

### 4.1 Требования к площадке

1. **Сервер**: Linux VM (например, `myr-vm1`, 16+ ядер, 64 ГБ RAM, файловая система XFS с квотами в `/srv/myrmidon-xfs`).
2. **Сеть**: Туннель IPsec между `vm-core` (`board.internal`) и `myr-vm1` (`fleetd.internal`). Порт `9100` не публикуется в публичную сеть.
3. **Генерация токена**:
   ```bash
   TOKEN=$(openssl rand -hex 32)
   ```

---

### 4.2 Конфигурация site-agent (`myr-vm1`)

Файл `/etc/myrmidon/fleetd.json` с правами `0600`:

```json
{
  "siteId": "myr-vm1",
  "epoch": 1,
  "listen": "0.0.0.0:9100",
  "token": "<TOKEN>",
  "upstream": "/var/run/docker.sock",
  "bots": [
    {
      "botKey": "work-qa",
      "maxMemoryMb": 4096,
      "maxCpus": 2.0,
      "maxPids": 512
    },
    {
      "botKey": "work-finansist",
      "maxMemoryMb": 4096,
      "maxCpus": 2.0,
      "maxPids": 512
    }
  ]
}
```

Сервис systemd `/etc/systemd/system/myrmidon-fleetd.service`:

```ini
[Unit]
Description=Myrmidon Fleet Site Agent
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/fleetd --config /etc/myrmidon/fleetd.json
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Запуск сервиса:
```bash
systemctl daemon-reload
systemctl enable --now myrmidon-fleetd
```

Проверка здоровья локально:
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://fleetd.internal:9100/v1/health | jq .
```

---

### 4.3 Настройка на стороне доски (`vm-core`)

В переменной окружения `MYRMIDON_FLEET_HOSTS` на `vm-core`:

```json
MYRMIDON_FLEET_HOSTS='[
  {
    "name": "myr-vm1",
    "url": "http://fleetd.internal:9100",
    "tokenSecret": "fleetd-myr-vm1-token",
    "hindsightUrl": "http://hindsight.internal:8890",
    "llmBaseUrl": "http://llm.internal:4000",
    "boardExtraHost": "paperclip-server-1",
    "volumeRoot": "/srv/myrmidon-xfs/myrmidon-bots",
    "network": "myrmidon-bots",
    "imageAllowlist": ["ghcr.io/itkadr-git/myrmidon-bot@sha256:*"]
  }
]'
```

В Company Secrets доски регистрируется секрет `fleetd-myr-vm1-token`, содержащий токен площадки.

---

### 4.4 Безостановочный перевод ботов под управление (Canary Rollout)

1. **Предварительная проверка**:
   - Проверить ответ `GET /v1/health` площадки.
   - Убедиться, что тома бота находятся в `/srv/myrmidon-xfs/myrmidon-bots/<botKey>/{hermes,workspace,scratch}`.
   - Убедиться в наличии дайджеста образа в манифесте релиза.
2. **Канареечный перевод (`work-qa`)**:
   - В карточке агента на доске выставляется: `container.enabled = true`, `container.host = "myr-vm1"`.
   - Реконсилер доски выполняет R3 maintenance окно (`pause` -> `drain` -> `writeProfile` -> `start`).
   - Агент площадки аллоцирует порт (например, `18642`), и карточка бота получает `apiBaseUrl = http://fleetd.internal:18642`.
3. **Проверка**:
   - Пробный запуск задачи: подтвердить сохранение истории сессии и извлечение памяти из локального C-MEM.
   - Проверить отсутствие утечек секретов в логах.
   - Убедиться, что вебхук Telegram продолжает работать без сбоев (вебхук принимает `vm-core`, направляя вызовы в Hermes шлюз).
4. **Волновой перевод**:
   - 1 волна: утилитарные боты.
   - 2 волна: инженерные боты.
   - 3 волна: основной бот `work`.
5. **План отката (Rollback)**:
   - При сбое у канарейки: вернуть карточку в ручной режим (`container.enabled = false`, `apiBaseUrl = http://fleetd.internal:18642`) либо перевести на локальный хост (`container.host = null`).
   - Данные на диске `/srv/myrmidon-xfs/myrmidon-bots` **никогда не удаляются**.
