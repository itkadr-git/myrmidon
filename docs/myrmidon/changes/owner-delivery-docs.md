## settings-en-append

<!-- section: Track 4 — chats and skills -->

The fallback delivery of decisions to the task owner's Telegram DM (U2,
see [guides/owner-telegram-cards.md](guides/owner-telegram-cards.md)) has no
environment variable of its own; its mode is an instance setting,
`instance_settings.general.ownerDelivery`, read with
`GET /api/myrmidon/owner-delivery` and changed with
`PATCH /api/myrmidon/owner-delivery` (`{ "mode": "via_bot" }`,
`{ "mode": "owner_decisions_only" }` or `{ "mode": "all" }`, instance
administrator; Company settings → Owner Telegram delivery shows the same
three choices). The default `via_bot` delivers decisions as plain bot messages
the owner answers in text (see the guide). In `owner_decisions_only` mode,
only cards addressed to a human (resolver policy `human_only`, or the task owner
as the addressee user) are delivered as cards with buttons; agent-addressed
and purely operational cards stay board-only. `all` delivers every card an
agent raises. Read at delivery time, no restart.

## settings-ru-append

<!-- section: Трек 4 — чаты и навыки -->

Резервная доставка решений в Telegram-личку владельца задачи (U2,
см. [guides/owner-telegram-cards.ru.md](guides/owner-telegram-cards.ru.md))
своей переменной окружения не имеет; её режим — настройка инстанса
`instance_settings.general.ownerDelivery`, читается запросом
`GET /api/myrmidon/owner-delivery` и меняется запросом
`PATCH /api/myrmidon/owner-delivery` (`{ "mode": "via_bot" }`,
`{ "mode": "owner_decisions_only" }` или `{ "mode": "all" }`, администратор
инстанса; тот же выбор из трёх вариантов — в настройках компании, раздел Owner
Telegram delivery). Режим по умолчанию `via_bot` доставляет решения обычным
сообщением бота, на которое владелец отвечает текстом (см. руководство).
В режиме `owner_decisions_only` карточками с кнопками доставляются только
карточки, адресованные человеку (политика резолвера `human_only` или
адресат-пользователь — владелец задачи); карточки с адресатом-агентом и чисто
операционные остаются только на доске. `all` доставляет каждую карточку,
поднятую агентом. Читается в момент доставки, без перезапуска.
