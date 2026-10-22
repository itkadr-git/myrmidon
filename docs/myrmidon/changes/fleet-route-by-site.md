---
divergence-section: FLEETD-VMEXEC — контейнеры ботов разработки на второй машине
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### FLEET-SITES T1/T3: bot containers routed by remote site (OPE-8326)

- The board wires `fleetRoutingDriver` into startup on top of the local docker driver; the site registry (`myrmidon_fleet_sites`, with affinity and move tables) and per-company fleet clients (bearer token, TLS server verification against the site's CA; no client certificate yet) resolve a card's `adapterConfig.container.site`. The registry is re-read every sweep period, so a new site needs no board restart.
- Legacy `adapterConfig.container.host` keeps resolving by direct URL; a card without site/host stays on local docker. A card that cannot be read, or names a site that is not active, is an error and never falls back to local docker. Optional driver methods keep working for local bots; for remote bots skills back-import and clone reports are skipped (logged once).

## changelog-ru

### FLEET-SITES T1/T3: маршрутизация контейнеров ботов по удалённой площадке (OPE-8326)

- Доска подключает `fleetRoutingDriver` в startup поверх локального docker-драйвера; реестр площадок (`myrmidon_fleet_sites`, таблицы affinity и moves) и клиенты площадок по компаниям (bearer-токен, проверка серверного TLS по CA площадки; клиентского сертификата пока нет) разрешают `adapterConfig.container.site` карточки. Реестр перечитывается каждый период свипа, новая площадка не требует рестарта доски.
- Прежний `adapterConfig.container.host` по-прежнему разрешается по прямому URL; карточка без site/host остаётся на локальном docker. Карточка, которую не удалось прочитать, или с неактивной площадкой — ошибка, не откат в локальный docker. Необязательные методы драйвера для локальных ботов работают как раньше; для удалённых бэкимпорт навыков и отчёт о клонах пропускаются (в лог один раз).

## divergence

| FLEET-SITES-ROUTE | Роутинг-драйвер `fleetd-routing.ts` подключён в `startup.ts` поверх локального docker-драйвера (раньше создавался только `dockerBotContainerDriver`). Площадка берётся из `adapterConfig.container.site` (реестр `myrmidon_fleet_sites`, `site-registry.ts`; клиенты по ключу «компания + имя», токен и проверка CA площадки, mTLS с клиентским сертификатом пока не реализован; реестр перечитывается каждый период свипа); прежний `container.host` продолжает разрешаться по прямому URL; карточка без site/host идёт в локальный docker. Необязательные методы (`listRunning`, `statusWithDrift`, `readCloneReport`, `readBotSkills`) роутер сохраняет для локальных ботов; удалённым они вслепую не проксируются (бэкимпорт навыков и отчёт о клонах пропускаются с записью в лог, дрейф считается через `status` + `templateDrift`). Ошибка чтения карточки пробрасывается (fail-closed), `hostPinned` роутером не читается. Валидация `container.site` при сохранении карточки Таблицы `myrmidon_fleet_sites`, `myrmidon_fleet_affinity`, `myrmidon_fleet_moves` (миграция 0401) | Только наши файлы: `fleetd-routing.ts`, `fleetd-hosts.ts`, `fleetd-driver.ts`, `site-registry.ts`, `startup.ts`, `agent-config.ts`, `index.ts`, `routes-wiring.ts`, схемы `myrmidon_fleet_*`, миграция 0401; вендор не тронут | Доска должна управлять ботами на удалённых площадках (1.6.6, OPE-7605 T1/T3) | `fleetd-routing.myrmidon.test.ts`, `fleetd-hosts.myrmidon.test.ts`, `site-registry.myrmidon.test.ts`, `startup.myrmidon.test.ts` (local / remote-by-host / remote-by-site / fail-closed / ready / optional-методы) | Не заводить площадки и `container.site` на карточках — роутинг всегда в локальный драйвер | OPE-8326 |

## settings-en-replace

| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | Map of named fleetd hosts for placing container bots: JSON array of entries `[{"name":"…","url":"http(s)://…","tokenSecret":"…"}]` — host name (the bot card references it in `adapterConfig.container.host`), fleetd service address (`http://` or `https://`, the server certificate is verified against the site's CA), name of the company secret with the fleetd token. In 1.6.6 T1, acts as bootstrap for the `myrmidon_fleet_sites` database table | Empty/unset — only the local driver, named hosts use the database registry; if neither exists, a card with `container.host` gets an error. Invalid JSON, unknown key, duplicate name or empty `tokenSecret` — an error logged, board continues serving. Read at server startup |

## settings-ru-replace

| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | не задан (пусто) | Карта именованных fleetd-хостов для размещения контейнерных ботов: JSON-массив записей `[{"name":"…","url":"http(s)://…","tokenSecret":"…"}]` — имя хоста (его же указывает карточка бота в `adapterConfig.container.host`), адрес fleetd-сервиса (`http://` или `https://`, серверный сертификат проверяется по CA площадки), имя секрета компании с токеном fleetd. В 1.6.6 T1 служит bootstrap для таблицы БД `myrmidon_fleet_sites` | Пусто/не задано — только локальный драйвер, именованные хосты берутся из реестра БД; если нет ни там, ни там — карточка с `container.host` получает ошибку. Неверный JSON, неизвестный ключ, дубликат имени или пустое `tokenSecret` — ошибка пишется в лог, доска продолжает работать. Читается при запуске сервера |
