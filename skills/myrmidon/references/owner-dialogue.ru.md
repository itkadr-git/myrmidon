# Решения владельца: объясняйте их сообщением, а не карточкой

Читайте это руководство, когда создаёте human-only `ask_user_questions` или `request_confirmation` для владельца задачи (`resolverPolicy: "human_only"` или `addresseeUserId` равен владельцу), а режим доставки владельцу — `via_bot` (по умолчанию).

Русская версия синхронизирована с `owner-dialogue.md`. Канонические ограничения транспорта, авторства и внешней доставки одинаковы в обеих версиях.

## Что получает владелец

В режиме `via_bot` владелец не получает в Telegram карточку с кнопками. Две строки и выбор из неясных вариантов ничего не объясняют. Объясните решение одним обычным сообщением; владелец отвечает в чате. Карточка взаимодействия остаётся на доске как запись. Для агента ничего больше не меняется: создайте interaction и ожидайте обычным способом (`in_review`).

Только решения владельца отправляются в его чат. Вопросы и подтверждения между агентами и операционные решения используют `addresseeAgentId` или `resolverPolicy: "anyone" | "not_creator"` и никогда не попадают в чат владельца.

## Шаг 1: один раз объясните решение

Используйте транспорт, реально доступный в текущем прогоне. Если `myrmidonMessageOwner` есть в текущем каталоге инструментов, вызовите его один раз со всеми открытыми необъяснёнными решениями владельца, которые создали вы. Если инструмента нет, не угадывайте имена и не повторяйте попытки. Используйте REST fallback только если текущий runtime предоставляет аутентифицированные базовый URL Paperclip API, API key и run ID:

```sh
curl -sS -X POST "$MYRMIDON_API_URL/api/myrmidon/owner-message" \
  -H "Authorization: Bearer $MYRMIDON_API_KEY" \
  -H "X-Paperclip-Run-Id: $MYRMIDON_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data '{"interactionIds":["<interaction-id>"],"text":"<plain-language explanation>"}'
```

Метод — `POST`, точный путь — `/api/myrmidon/owner-message`, а не URL issue interaction.

Сохраните JSON-ответ и его `publicationId`:

```sh
response="$(curl -sS -X POST "$MYRMIDON_API_URL/api/myrmidon/owner-message" \\
  -H "Authorization: Bearer $MYRMIDON_API_KEY" \\
  -H "X-Paperclip-Run-Id: $MYRMIDON_RUN_ID" \\
  -H 'Content-Type: application/json' \\
  --data '{"interactionIds":["<interaction-id>"],"text":"<plain-language explanation>"}')"
printf '%s\n' "$response"
publication_id="$(printf '%s' "$response" | jq -r '.publicationId')"
```

Ответ owner-message намеренно возвращает `publicationId`, но не `endpointId` и `conversationId`. Текущий агентский транспорт не имеет поддерживаемого read endpoint, который разрешает эти два ID. Не угадывайте их.

Оператор должен выполнить read-back с доступом к доске: сначала получить binding задачи, затем запросить статус публикации. `<task-id>` и `<publication-id>` замените фактическими значениями:

```sh
binding="$(curl -sS "$MYRMIDON_API_URL/api/issues/<task-id>/chat-binding" \\
  -H "Authorization: Bearer $MYRMIDON_API_KEY")"
endpoint_id="$(printf '%s' "$binding" | jq -r '.endpointId')"
conversation_id="$(printf '%s' "$binding" | jq -r '.conversationId')"
curl -sS "$MYRMIDON_API_URL/api/chat-endpoints/$endpoint_id/conversations/$conversation_id/publications/<publication-id>/status" \\
  -H "Authorization: Bearer $MYRMIDON_API_KEY"
```

Для POST используйте identity того же прогона; не занимайте чужой ключ и не выдавайте себя за владельца. Binding lookup и status GET могут требовать board-authorized key оператора, потому что owner-message не возвращает IDs binding. Если в runtime нет нужного credential или run ID, остановитесь и сообщите точное ограничение. Успешный POST или статус `pending` не доказывает доставку: принимайте только статус, где `publication.state` равен `published`, а `publishedAt` не равен null (либо эквивалентный provider delivery receipt). Никогда не отправляйте настоящее сообщение владельцу для теста.

## Ошибки и безопасное восстановление

- `400` validation error: проверьте непустые `interactionIds` и `text`; не повторяйте запрос с пустым телом.
- `403 not_author_of_open_owner_decision`: только автор открытого решения может его объяснить. Не используйте identity другого агента.
- `404`: проверьте точный POST path выше и попросите оператора проверить deployed version/mount. Не выдумывайте route и не ищите бесконечно отсутствующий tool.
- `409 summary_required`: включите в одно summary все открытые необъяснённые решения этого владельца.
- `409 already_explained`: не отправляйте повторно; ожидайте владельца.
- `409 no_owner_dm`: попросите оператора установить поддерживаемый direct chat; не создавайте новый транспорт.

Пишите владельцу на его языке: что решить, почему сейчас, последствия каждого варианта, ваша рекомендация и как ответить. Не используйте interaction IDs, названия API и таблицы.

## Шаг 2: обработайте ответ владельца

Текстовый ответ владельца приходит обычным сообщением в вашем direct chat. В prompt появится пометка «The owner's message may answer an open decision» с открытыми interactions и ID комментария владельца.

Если владелец явно решил вопрос, используйте `myrmidonResolveInteractionByOwnerReply` только если этот tool действительно доступен в текущем каталоге; иначе используйте `POST /api/myrmidon/owner-message/resolve` с той же run-scoped аутентификацией. Передайте `interactionId`, `ownerReplyCommentId`, `action` и `body`.

- `accept` / `reject` для `request_confirmation`; `respond` для `ask_user_questions`.
- `body`: для accept `{}`; для reject `{"reason": "..."}`; для respond `{"answers": [{"questionId": "...", "optionIds": ["..."], "otherText": null}]}`.
- Interaction закрывается от имени OWNER; вы никогда не закрываете human-only interaction от своего имени.

Сервер отклоняет resolve, если `ownerReplyCommentId` не принадлежит владельцу и этому direct chat после объяснения (`403 no_owner_reply`), если вы не автор interaction или действие не соответствует виду interaction (`422 action_kind_mismatch`). Молчание, ваши рассуждения и слова другого человека не закрывают решение. Подтверждения действий инструментов, предложения секретов и авторизация подключений остаются явными решениями на доске.
