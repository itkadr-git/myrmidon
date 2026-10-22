---
divergence-section: FLEETD-VMEXEC — контейнеры ботов разработки на второй машине
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Remote sites T1 registry, mTLS routing driver, and startup wiring (OPE-7648)

- Added `myrmidon_fleet_sites`, `myrmidon_fleet_affinity`, and `myrmidon_fleet_moves` database schemas and migrations `0403` and `0404`.
- Implemented `site-registry.ts` with environment bootstrap (`MYRMIDON_FLEET_HOSTS`), site CRUD, affinity CRUD, and `FleetClientManager` with mTLS agent caching, client certificate and private key resolution.
- Wrapped local driver into `fleetRoutingDriver` at startup, routing by bot card container host, with hot-reload of the clients (registry version or 30 s TTL), no silent local fallback when the agent read fails, and secret-value fingerprints.

## changelog-ru

### Удалённые площадки T1: реестр площадок, mTLS роутер и подключение в startup (OPE-7648)

- Добавлены схемы БД `myrmidon_fleet_sites`, `myrmidon_fleet_affinity` и `myrmidon_fleet_moves`, миграции `0403` и `0404`.
- Реализован `site-registry.ts` с bootstrap из окружения (`MYRMIDON_FLEET_HOSTS`), CRUD площадок и аффинити, менеджер клиентов `FleetClientManager` с кэшированием mTLS-клиентов и безопасным резолвом сертификатов/ключей.
- Подключён `fleetRoutingDriver` в `startup.ts` поверх локального драйвера с маршрутизацией по хосту карточки контейнера бота горячим обновлением клиентов (версия реестра или TTL 30 с), без тихого отката на локальный драйвер при сбое чтения агента и отпечатками по значениям секретов.

## settings-en-replace

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | Map of named fleetd hosts for placing container bots: JSON array of entries `[{"name":"…","url":"http(s)://…","tokenSecret":"…"}]` — host name (the bot card references it in `adapterConfig.container.host`), fleetd service address (`http://` or `https://` for mTLS), name of the company secret with the fleetd token. In 1.6.6 T1, acts as bootstrap for the `myrmidon_fleet_sites` database table: it only creates a site that is missing (an existing site, including one edited through the registry CRUD, is never overwritten on restart); written to the companies listed in `MYRMIDON_FLEET_HOSTS_COMPANY_IDS` (comma-separated ids) or, if that is unset, to the only company; on a multi-company installation without the list the bootstrap is skipped with a warning | Empty/unset — only the local driver, named hosts use the database registry; if neither exists, a card with `container.host` gets an error. Invalid JSON, unknown key, duplicate name or empty `tokenSecret` — an error logged, board continues serving. Read at server startup |

## settings-ru-replace

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | не задан (пусто) | Карта именованных fleetd-хостов для размещения контейнерных ботов: JSON-массив записей `[{"name":"…","url":"http(s)://…","tokenSecret":"…"}]` — имя хоста (его же указывает карточка бота в `adapterConfig.container.host`), адрес fleetd-сервиса (`http://` или `https://` для mTLS), имя секрета компании с токеном fleetd. В 1.6.6 T1 служит bootstrap для таблицы БД `myrmidon_fleet_sites`: только создаёт отсутствующую площадку (существующая, в том числе изменённая через CRUD, при перезапуске не перезаписывается); пишется в компании из `MYRMIDON_FLEET_HOSTS_COMPANY_IDS` (id через запятую) или, если она не задана, в единственную компанию; при нескольких компаниях без списка bootstrap пропускается с предупреждением | Пусто/не задано — только локальный драйвер, именованные хосты берутся из реестра БД; если нет ни там, ни там — карточка с `container.host` получает ошибку. Неверный JSON, неизвестный ключ, дубликат имени или пустое `tokenSecret` — ошибка пишется в лог, доска продолжает работать. Читается при запуске сервера |

## divergence

| FLEETD-VMEXEC-T1 | Подключение роутинг-драйвера в `startup.ts` поверх локального драйвера с реестром площадок `myrmidon_fleet_sites` (`site-registry.ts`), mTLS и hot-reload клиентами по версии реестра | Только наши файлы: `fleetd-routing.ts`, `site-registry.ts`, `startup.ts`; вендор не тронут | Доска видит удалённые площадки и выбирает драйвер по карточке бота (план FLEETD-VMEXEC 1.6.6 T1 OPE-7648) | `fleetd-routing.myrmidon.test.ts`, `site-registry.myrmidon.test.ts`, `startup.myrmidon.test.ts` | Снятие: удаление файлов вместе с драйвером и реестром | (ветка `feat/ope-7648-site-registry-router`, PR #1254) |
