---
---

## changelog-en

### Wizard endpoints stuck in `verifying` are finished by live traffic (1.6.5 F-10 A)

- An endpoint whose setup wizard stopped at the test step no longer needs the
  owner to press "Finish setup" once real traffic has proven both halves of the
  round trip: the board delivered an outgoing message through it
  (`chat_publications` in the `published` state) and an incoming turn came back.
  Such an endpoint becomes `active` on its own, with the test step completed,
  the test timestamp cleared and the health line `Verified by live traffic`;
  its tool connection turns active and healthy. The completion is recorded in
  the activity journal (`chat_endpoint.auto_activated`, trigger
  `live_traffic`) and can never happen twice or half-way: an endpoint with only
  incoming or only outgoing traffic stays where the wizard put it, and for the
  first minutes after a test starts the wizard keeps its endpoint (the owner is
  looking at it).
- The endpoint detail and list responses now carry `verifyingStale` — an
  endpoint that has been sitting in the test step for more than a day while
  deliveries keep succeeding. It is an attention flag for the interface and for
  diagnostics, never a status change and never an error.

## changelog-ru

### Эндпоинты, зависшие в `verifying`, достраивает живой трафик (1.6.5 F-10 A)

- Эндпоинту, чей мастер настройки остановился на шаге проверки, больше не нужно
  нажатие «Finish setup»: как только через него прошёл реальный живой трафик —
  доска доставила исходящее сообщение (`chat_publications` в состоянии
  `published`) и пришёл входящий ответ — настройка завершается сама. Эндпоинт
  становится `active`, шаг проверки закрывается, отметка времени проверки
  очищается, а строка здоровья показывает `Verified by live traffic`; его
  подключение инструмента переходит в active/healthy. Завершение записывается в
  журнал активности (`chat_endpoint.auto_activated`, триггер `live_traffic`) и
  не может ни случиться дважды, ни сработать наполовину: эндпоинт с одним только
  входящим или одним только исходящим трафиком остаётся там, куда его поставил
  мастер, а первые минуты после старта проверки эндпоинт принадлежит мастеру
  (владелец как раз смотрит на него).
- В ответах детали и списка эндпоинтов появился признак `verifyingStale` —
  эндпоинт, который больше суток стоит на шаге проверки, пока доставки через
  него продолжают проходить. Это сигнал внимания для интерфейса и диагностики,
  не смена статуса и не ошибка.

## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.5 — F-10 A: автоактивация эндпоинта живым трафиком и признак застрявшего verifying

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.5-F10-A | Завершение настройки канала живым трафиком + признак застрявшего `verifying`. Новый идемпотентный путь `activateChatEndpointFromLiveTraffic`: эндпоинт в `verifying` на шаге `test` (того же поколения рантайма и с той же отметкой старта проверки), у которого есть хотя бы одна публикация в состоянии `published` и зафиксирован входящий ход, переводится в `active`: шаг `complete`, `testStartedAt` очищен, `healthMessage` = `Verified by live traffic`, `activatedAt` выставлен через `coalesce`, подключение инструмента — в active/healthy; запись в журнал `chat_endpoint.auto_activated` (актор system, сущность `tool_connection`, `details.trigger` = `live_traffic`). Апдейт под тем же guarded WHERE, что и ручное завершение, — повтор ничего не переписывает и вторую запись журнала не создаёт, гонка двух вызовов даёт ровно одну активацию. Точки вызова: приём входящего (после коммита) и подтверждение исходящей доставки; вспомогательная обёртка не может уронить ни приём, ни доставку. Первые 15 минут после старта проверки шаг остаётся за мастером; условие двойное — без доставленной исходящей активации нет. Второе: выборка `listVerifyingStaleEndpoints` (эндпоинт в `verifying` дольше суток по отметке старта проверки и при этом успешная доставка за последние сутки) и флаг `verifyingStale` в ответах детали и списка эндпоинтов — только сигнал для интерфейса и диагностики, статус не меняется | Наши файлы: `server/src/myrmidon/chat-live-traffic-activation.ts`; в вендоре помечены `myrmidon(1.6.5-F10-A)`: `server/src/services/chat-channels.ts` (импорт, обёртка `tryLiveTrafficActivation`, два вызова — после коммита приёма входящего и после подтверждения исходящей доставки, `verifyingStale` в сериализации, отметка флага в `list`/`get`), `packages/shared/src/types/chat-channels.ts` (одно необязательное поле), тест `server/src/__tests__/chat-channels.integration.test.ts` | Эпик 1.6.5 F-10: TG-эндпоинты вечно стоят в `verifying`, потому что завершение ставит только ручное нажатие в мастере, хотя трафик через канал уже ходит; владелец не возвращается к мастеру, и канал считается неготовым. Признак `verifyingStale` — сигнал внимания там, где трафик есть, а завершения нет больше суток | `server/src/__tests__/chat-channels.integration.test.ts` (на embedded postgres: шаг `test` + доставленная публикация + входящий ход → `active`, `setup.step` = `complete`, `testStartedAt` очищен, `healthMessage` = `Verified by live traffic`, подключение active/healthy, ровно одна запись `chat_endpoint.auto_activated`; повторный вызов и гонка двух вызовов — без второй записи; свежий шаг после живого трафика остаётся `verifying`; эндпоинт только с входящим без доставленной исходящей — остаётся `verifying`, записей нет; признак `verifyingStale` — в детали и в списке, снимается сразу после активации) | Никогда, наше поведение: вендорский ручной путь завершения мастера сохранён и не менялся. Снятие: удалить `chat-live-traffic-activation.ts`, маркеры `myrmidon(1.6.5-F10-A)` в `chat-channels.ts` (импорт, обёртку, два вызова, флаг и его отметку), поле `verifyingStale` в shared и три теста в вендорском suite | (этот PR) |