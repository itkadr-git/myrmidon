## changelog-en

### Owner-DM delivery filter: only cards addressed to a human reach the task owner's Telegram (1.6.5-OWNER-DM-FILTER)

- Owner-DM delivery filter (U2): in the default mode `owner_decisions_only` the task owner's Telegram DM receives only cards addressed to a human — interactions whose effective resolver policy is `human_only`, or whose `addresseeUserId` is the task owner.
- Agent-addressed and purely operational confirmations (resolverPolicy `anyone`/`not_creator` without a human addressee) stay board-only instead of flooding the owner's DM.
- The mode lives in `instance_settings.general[ownerDelivery]` and is read/written via `GET/PATCH /api/myrmidon/owner-delivery` (read: any board member, write: instance admin); `mode: "all"` restores the pre-filter behaviour.
- Cards delivered to the owner DM carry a human-readable header line ("Нужно ваше решение: <prompt>") built from the interaction's own fields — vendor bindings keep the vendor card text byte-for-byte.

## changelog-ru

### Фильтр owner-доставки: в Telegram владельца приходят только карточки, адресованные человеку (1.6.5-OWNER-DM-FILTER)

- Фильтр owner-доставки карточек в Telegram (U2): в режиме по умолчанию `owner_decisions_only` в ЛС владельца задачи попадают только карточки, адресованные человеку — с effectiveResolverPolicy `human_only` или с addresseeUserId равным владельцу задачи.
- Карточки с адресатом-агентом и чисто операционные подтверждения (resolverPolicy `anyone`/`not_creator` без адресата-человека) остаются только на доске.
- Режим хранится в `instance_settings.general[ownerDelivery]`, читается/пишется через `GET/PATCH /api/myrmidon/owner-delivery` (чтение — любой участник доски, запись — instance admin); `mode: "all"` возвращает старое поведение.
- Карточки в ЛС владельца получают человекочитаемый заголовок («Нужно ваше решение: <prompt>») из полей самого interaction; вендорские биндинги отдают прежний текст без изменений.
