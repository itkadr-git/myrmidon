# Архитектура компонентов Myrmidon / Myrmidon Architecture Index

> Сводный реестр и статус готовности страниц архитектуры компонентов (KNOWLEDGE-2.0 L-10).
> Автоматически сформировано утилитой `scripts/validate-architecture-docs.mjs`.

## Сводка готовности / Summary

- **Всего компонентов:** 25
- **Файлов в наличии:** 15 / 25
- **Полностью готовы (все обязательные секции):** 5
- **В работе / неполные (отсутствуют требуемые секции):** 10
- **Отсутствуют:** 10
- **Ошибки синтаксиса:** 0 (нет)

### Обязательные секции шаблона (L-10)

1. **Как задумано** (`## Как задумано` / `## How it is intended`) — целевая архитектура и инварианты.
2. **Как сделано** (`## Как сделано` / `## How it is implemented`) — фактическая реализация в коде.
3. **Расхождения** (`## Расхождения` / `## Difference from the intended design`) — отклонения, компромиссы, долг.

---

## Таблица статусов 25 проектных компонентов

| № | Компонент | Файл | Группа | Как задумано | Как сделано | Расхождения | Статус |
|---|---|---|---|:---:|:---:|:---:|---|
| 1 | Хранилище и захват задач <br> *(Issue store and checkout)* | [`issue-store-checkout.md`](./issue-store-checkout.md) | Ядро очереди и heartbeat | ✅ | ✅ | ✅ | 🟢 Готов |
| 2 | Heartbeat и runner <br> *(Heartbeat and runner)* | [`heartbeat-runner.md`](./heartbeat-runner.md) | Ядро очереди и heartbeat | ✅ | ✅ | ✅ | 🟢 Готов |
| 3 | Очередь задач <br> *(Task queue)* | [`task-queue.md`](./task-queue.md) | Ядро очереди и heartbeat | ✅ | ✅ | ✅ | 🟢 Готов |
| 4 | Inbox-lite <br> *(Inbox-lite)* | [`inbox-lite.md`](./inbox-lite.md) | Ядро очереди и heartbeat | ✅ | ✅ | ✅ | 🟢 Готов |
| 5 | Блокировки и зависимости <br> *(Blocks and dependencies)* | [`blocks-dependencies.md`](./blocks-dependencies.md) | Ядро очереди и heartbeat | ✅ | ✅ | ✅ | 🟢 Готов |
| 6 | Структура страниц UI <br> *(UI page structure)* | [`ui-page-structure.md`](./ui-page-structure.md) | UI и API оркестратора | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 7 | Топология API маршрутов <br> *(API route topology)* | [`api-route-topology.md`](./api-route-topology.md) | UI и API оркестратора | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 8 | SSE/стриминг прогонов <br> *(Live run streaming)* | [`live-run-streaming.md`](./live-run-streaming.md) | UI и API оркестратора | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 9 | Статус-карточки и дашборд <br> *(Status cards dashboard)* | [`status-cards-dashboard.md`](./status-cards-dashboard.md) | UI и API оркестратора | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 10 | Экран настроек <br> *(Settings screen)* | [`settings-screen.md`](./settings-screen.md) | UI и API оркестратора | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 11 | Слои памяти (Hindsight / Memory) <br> *(Memory layers)* | [`memory-layers.md`](./memory-layers.md) | Память и знания | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 12 | PARA-файлы памяти <br> *(PARA memory files)* | [`para-memory-files.md`](./para-memory-files.md) | Память и знания | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 13 | Wiki-cortex <br> *(Wiki-cortex)* | [`wiki-cortex.md`](./wiki-cortex.md) | Память и знания | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 14 | Foraging (сбор знаний) <br> *(Foraging)* | [`foraging.md`](./foraging.md) | Память и знания | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 15 | Доставка знаний (KNOWLEDGE_INDEX) <br> *(Knowledge deliveries)* | [`knowledge-deliveries.md`](./knowledge-deliveries.md) | Память и знания | ❌ | ❌ | ❌ | 🟡 В работе (неполный) |
| 16 | Адаптеры агентов <br> *(Agent adapters)* | `agent-adapters.md` | Агенты и исполнение | — | — | — | 🔴 Отсутствует |
| 17 | Рабочие пространства исполнения <br> *(Execution workspaces)* | `execution-workspaces.md` | Агенты и исполнение | — | — | — | 🔴 Отсутствует |
| 18 | Чат агентов <br> *(Agent chat)* | `agent-chat.md` | Агенты и исполнение | — | — | — | 🔴 Отсутствует |
| 19 | Дебаты агентов <br> *(Debates)* | `debates.md` | Агенты и исполнение | — | — | — | 🔴 Отсутствует |
| 20 | Обмен сообщениями агентов <br> *(Agent exchange)* | `agent-exchange.md` | Агенты и исполнение | — | — | — | 🔴 Отсутствует |
| 21 | Доставка сообщений владельцу <br> *(Owner delivery)* | `owner-delivery.md` | Доставка и каналы | — | — | — | 🔴 Отсутствует |
| 22 | Мост чата с агентом (Telegram) <br> *(Agent chat bridge)* | `agent-chat-bridge.md` | Доставка и каналы | — | — | — | 🔴 Отсутствует |
| 23 | Полезная нагрузка wake/heartbeat <br> *(Wake and heartbeat payload)* | `wake-heartbeat-payload.md` | Доставка и каналы | — | — | — | 🔴 Отсутствует |
| 24 | Комментарии и взаимодействия <br> *(Comments and interactions)* | `comments-interactions.md` | Доставка и каналы | — | — | — | 🔴 Отсутствует |
| 25 | Согласования <br> *(Approvals)* | `approvals.md` | Доставка и каналы | — | — | — | 🔴 Отсутствует |

---

## Дополнительные архитектурные документы (Substrate / Runner)

| Документ | Статус синтаксиса |
|---|---|
| [`durable-continuation-scheduler.md`](./durable-continuation-scheduler.md) | 🟢 Синтаксис корректен |
| [`native-status-arbitration.md`](./native-status-arbitration.md) | 🟢 Синтаксис корректен |
| [`paperclip-runner-compatibility.md`](./paperclip-runner-compatibility.md) | 🟢 Синтаксис корректен |
| [`paperclip-runner-daytona-networking.md`](./paperclip-runner-daytona-networking.md) | 🟢 Синтаксис корректен |
| [`paperclip-runner.md`](./paperclip-runner.md) | 🟢 Синтаксис корректен |

---

## Проверка и актуализация

Для повторной сверки документов и обновления индекса запустите:
```bash
node scripts/validate-architecture-docs.mjs
```

Для проверки соответствия в CI без перезаписи:
```bash
node scripts/validate-architecture-docs.mjs --check
```
