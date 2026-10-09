---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### `/agents` in Telegram answers with buttons (1.6.5 F-07 part B)

- `/agents` in the owner's bridged Telegram chat now opens the company's directions as buttons, each with the count of its live agents. A direction opens its agents (ten to a page, "More" for the rest), and an agent opens its own card with three actions: **Write to this agent** (the same effect as `/to <alias>`: the chat's default addressee becomes that agent), **Model** (the model this chat uses for that agent and the choices it has) and **Stop** (stops that agent's runs in this chat only). Paused, retired, service and terminated cards are not listed.
- `/agents text` keeps the plain grouped list for a client without buttons.
- The buttons work for ten minutes and only for the owner of that Telegram conversation; a stale button answers "send /agents again", another person's click changes nothing. Button and message texts follow the chat owner's language (en/ru catalogs).

## changelog-ru

### `/agents` в Telegram отвечает кнопками (1.6.5 F-07, часть B)

- `/agents` в связанном Telegram-чате владельца теперь открывает направления компании кнопками, на каждой — число живых агентов. Направление открывает своих агентов (по десять на странице, «Ещё» — остальные), агент открывает свою карточку с тремя действиями: **Написать этому агенту** (тот же эффект, что у `/to <алиас>`: адресатом чата по умолчанию становится этот агент), **Модель** (какая модель используется в этом чате для агента и из чего можно выбирать) и **Стоп** (останавливает прогоны этого агента только в этом чате). Агенты на паузе, архивные, служебные и удалённые в списках не показываются.
- `/agents text` оставляет прежний текстовый список группами — для клиента без кнопок.
- Кнопки живут десять минут и работают только у владельца этого Telegram-чата; устаревшая кнопка отвечает «отправьте /agents заново», чужое нажатие ничего не меняет. Тексты кнопок и сообщений — на языке владельца чата (каталоги en/ru).

## divergence

| 1.6.5-F07-B | Ответ `/agents` в мосте Telegram — карточка с inline-кнопками (направления, страница агентов, действия агента), `/agents text` — прежний текст. Ответ команды моста (`BridgedCommandResult.reply`) может нести `screen` (заголовок, текст, кнопки); `projectSafeChatPublication` принимает автономную карточку `card` (только `source: "task_control"`, без `interactionId`, максимум 12 действий), поэтому ничто, что ищет взаимодействие по `interactionId`, её не видит. Каждая кнопка — случайный токен `pca:…` в `chat_actions` вида `agents_button` (действие, публикация, срок 10 минут); в `callback_data` Telegram идёт только токен. Нажатие разбирает `handleAgentsButtonClick` в `chat-channels.ts` (до пути вопросов/подтверждений): токен действующий и принадлежит этому боту, сообщение — та публикация, для которой он выдан, `callback_data` в точности конверт токена, чат — личка владельца; затем текущая проверка прав внешнего действия и контекст команд моста (отправитель — владелец этого Telegram-диалога). «Написать» — тот же `handleToCommand`, «Стоп» — `stopBridgedChatRuns`, ответ нового экрана — новая публикация `task_control` | Наши файлы: `server/src/myrmidon/agent-chat-bridge/commands/agents-buttons.ts`, правки под маркером `myrmidon(1.6.5 F-07 part B)` в `commands/index.ts`, `commands/agents.ts`, `bridge.ts`, `locales/{en,ru}.ts`; вендор: `server/src/services/chat-channels.ts` (хук `handleAgentsButtonClick` перед разбором вопросов и подтверждений), `server/src/services/chat-publication-projection.ts` (автономная карточка `task_control`) | Владелец просил `/agents` интерактивным (08.10): выбор адресата в два нажатия вместо `/to <алиас>` | `server/src/myrmidon/agent-chat-bridge/commands/agents-buttons.myrmidon.test.ts`, `server/src/services/chat-publication-projection.myrmidon.test.ts` | Когда вендор получит командные ответы с кнопками на своей стороне | см. PR |
