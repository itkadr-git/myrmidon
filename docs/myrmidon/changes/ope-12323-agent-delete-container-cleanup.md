## changelog-en

### Fail-closed bot container cleanup on agent termination and deletion (OPE-12323, PR #2803)

- Terminating (`POST /api/agents/:id/terminate`) or deleting (`DELETE /api/agents/:id`) an agent with an active bot container now performs a fail-closed cleanup against the execution runtime or remote fleetd site (`POST /v1/bots/:botKey/cleanup` or `DELETE /v1/bots/:botKey`).
- The cleanup removes both the running Docker container and the host-side bot volume directory (`volumeRoot/:botKey`), preventing orphaned containers and residual disk usage.
- The operation is fail-closed: if the remote site is unreachable or container cleanup fails, the terminate/delete endpoint returns an error and leaves the agent record in the database so the operation can be retried safely.
- The fleetd route `/v1/bots/:botKey/cleanup` (also accepting `DELETE`) is idempotent and treats missing containers (Docker 404) or already-removed data directories as successful cleanups.

## changelog-ru

### Очистка контейнеров ботов по принципу fail-closed при завершении и удалении агентов (OPE-12323, PR #2803)

- При завершении (`POST /api/agents/:id/terminate`) или удалении (`DELETE /api/agents/:id`) агента с активным контейнером теперь выполняется fail-closed очистка в рантайме контейнеров или на удалённой площадке fleetd (`POST /v1/bots/:botKey/cleanup` или `DELETE /v1/bots/:botKey`).
- Очистка останавливает и удаляет Docker-контейнер, а также удаляет каталог данных бота на хосте (`volumeRoot/:botKey`), предотвращая появление забытых (orphaned) контейнеров и утечки диска.
- Операция работает по принципу fail-closed: если удалённая площадка недоступна или вызов очистки возвращает ошибку, завершение или удаление агента прерывается с ошибкой, а запись агента в базе данных остаётся нетронутой для возможности повтора.
- Маршрут fleetd `/v1/bots/:botKey/cleanup` (также доступный по `DELETE`) идемпотентен: отсутствие контейнера в Docker (404) или уже удалённый каталог считаются успешным завершением.
