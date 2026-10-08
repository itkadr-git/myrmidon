---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### The owner's own words close the pending owner card (1.6.5-F21-A)

- An answer written by the owner in a chat (a Telegram DM with the authoring agent, or a comment the owner leaves on the task) now closes the freshest pending owner card of that task. The decision talks to the existing resolution services; the owner is attributed as the resolver, so nothing about the card state machine changes.
- The same wording is used in both places: the inbound chat writer reads the owner's message with this parse (it can name an option by number or letter and pick the card's recommended option) and keeps its own free-text reading as the fallback for cards that accept a typed-in answer.
- The sentence is read against a RU/EN phrase table: "да / ок / делай / согласен / go ahead" accepts a confirmation, "нет / стоп / не надо / cancel" rejects it. Option cards match an option by number ("2) да"), by letter ("вариант б"), by the option's own wording, and "по твоим рекомендациям / the recommended one" picks the option the card marks as recommended. A free-text answer lands in the question's own free-text option when it has one.
- A sentence that decides nothing is never treated as a decision: the text is kept as the owner's comment, the card stays pending with a note saying the answer did not decide, and the question is re-sent with buttons — once per answer.
- Cards raised before the owner ever received a DM carry no message binding. They are closed by the same task-level rule, which is why no data migration is needed.
- When several cards of the task are pending, one line with buttons asks which question the answer belongs to instead of guessing.
- Setting: none. The behaviour rides the existing owner delivery mode (`via_bot`); in every other mode the path is inert.

## changelog-ru

### Ответ владельца словами закрывает pending-карточку (1.6.5-F21-A)

- Ответ, написанный владельцем в чате (личка Telegram с агентом-автором либо комментарий владельца на задаче), закрывает самую свежую pending owner-карточку этой задачи. Решение уходит в существующие сервисы резолва, владелец атрибутируется как резолвер — машина состояний карточки не меняется.
- Формулировки разбираются одинаково в обоих местах: входящее сообщение владельца в чате читается этим же разбором (опцию можно назвать номером или буквой, «рекомендованная» — по пометке карточки), а собственное чтение свободного текста остаётся запасным для карточек, принимающих вписанный ответ.
- Фраза разбирается по таблице RU/EN: «да / ок / делай / согласен / go ahead» принимают подтверждение, «нет / стоп / не надо / cancel» отклоняют. Карточка-вопрос сопоставляет опцию по номеру («2) да»), по букве («вариант б»), по формулировке опции, а «по твоим рекомендациям / the recommended one» берёт опцию, помеченную в карточке рекомендованной. Свободный текст попадает в собственный free-text вариант вопроса, если он есть.
- Фраза, которая ничего не решает, решением не считается: текст остаётся комментарием владельца, карточка остаётся pending с пометкой «ответ без решения», вопрос пересылается кнопками — один раз на ответ.
- Карточки, созданные до того, как владелец получил личку, не имеют привязки к сообщению. Их закрывает то же правило уровня задачи, поэтому миграция данных не нужна.
- Если pending-карточек задачи несколько, одна строка с кнопками спрашивает, к какому вопросу ответ, — вместо угадывания.
- Настройка: нет. Поведение работает в существующем режиме доставки владельцу (`via_bot`), в остальных режимах путь неактивен.

## divergence

| 1.6.5-F21-A | Ответ владельца словами закрывает pending-карточку задачи: разбор фраз RU/EN → решение/опция (номер, буква, формулировка, «рекомендованная»), неоднозначное → свободный текст в комментарий + переспрос кнопками один раз на ответ; несколько pending-карточек → одна строка с кнопками «к какому вопросу ответ»; закрытие идёт через существующие сервисы резолва с атрибуцией владельца-резолвера; карточки без привязки к сообщению (до `via_bot`) закрываются тем же правилом уровня задачи, миграции нет | Наши файлы: `server/src/myrmidon/owner-reply/{parse-owner-reply,owner-reply-card,pending-owner-cards,owner-reply-plan,owner-task-reply,owner-reply-execution,owner-reply-classifier,index}.ts`. Вендор помечен `myrmidon(1.6.5-F21-A)`: `server/src/routes/issues.ts` (хук в маршруте создания комментария задачи — комментарий владельца на задаче, за гейтом режима доставки владельцу) и `server/src/services/chat-channels.ts` (одна строка: разбор слов владельца на существующем вызове писателя входящего сообщения, там же, где писатель зовётся сегодня) | Дефект: `authorizeOwnerReplyResolution` принимал ответ владельца только когда карточка привязана к сообщению в личке (`listOwnerExplanations` + inbound-связь комментария) — карточки, созданные до появления привязки, закрыть словами владельца было нельзя | `server/src/myrmidon/owner-reply/parse-owner-reply.myrmidon.test.ts` (таблица фраз → решение/опция; неоднозначное и проза не закрывают карточку), `server/src/myrmidon/owner-reply/owner-reply-flow.myrmidon.test.ts` (план и обработчик: закрытие свежей карточки, переспрос, «ответ без решения» с одним повтором, несколько карточек → переспрос кнопками, выбор карточки без привязки, другие режимы неактивны) | Когда вендор сам начнёт закрывать карточку по словам владельца в задаче: удалить каталог `server/src/myrmidon/owner-reply/` и куски `myrmidon(1.6.5-F21-A)` в маршруте комментариев и в `chat-channels.ts` | (этот PR) |