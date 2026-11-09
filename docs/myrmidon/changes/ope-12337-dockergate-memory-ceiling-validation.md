## changelog-en

### Bot card: validate memoryMb, cpus and pidsLimit against dockergate platform ceilings (1.6.7 OPE-12337)

- Saving or updating an agent card with `adapterConfig.container` now validates requested resources against enrolled dockergate limits (route A21 `GET /myrmidon/bots/{botKey}/limits` / platform ceilings).
- An update exceeding enrolled ceilings is rejected at card save time with HTTP 422 ("exceeds dockergate ceiling ... for this bot; raise bots[].maxMemoryMb in dockergate config.json and reload dockergate (SIGHUP)") rather than silently saving and failing later during container reconciliation with 403 `dockergate: denied (limit_exceeds_enrollment)`.
- The bot container status API (`GET /api/myrmidon/agents/:id/bot-container/status`) and agent card UI now report the running container's actual resource limits alongside requested card limits and display divergence warnings with the reconciliation denial reason when they differ.

## changelog-ru

### Карточка бота: валидация memoryMb, cpus и pidsLimit против потолков dockergate (1.6.7 OPE-12337)

- Сохранение и обновление карточки агента с `adapterConfig.container` теперь проверяет запрашиваемые ресурсы против зарегистрированных потолков dockergate (маршрут A21 `GET /myrmidon/bots/{botKey}/limits` / platform ceilings).
- Превышение потолка отклоняется при сохранении карточки с HTTP 422 («exceeds dockergate ceiling ... for this bot; raise bots[].maxMemoryMb in dockergate config.json and reload dockergate (SIGHUP)») вместо тихого сохранения и последующего сбоя при сверке контейнеров с 403 `dockergate: denied (limit_exceeds_enrollment)`.
- API статуса контейнера бота (`GET /api/myrmidon/agents/:id/bot-container/status`) и интерфейс карточки агента теперь отображают фактические лимиты ресурсов работающего контейнера рядом с запрошенными в карточке и выводят предупреждение о расхождении с причиной последнего отказа сверки.
