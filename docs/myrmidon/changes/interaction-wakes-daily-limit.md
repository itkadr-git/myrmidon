## changelog-en

### A pending question card now wakes its addressee even after the daily run limit

An agent that had used its daily run limit (`runtime_config.heartbeat.maxDailyRuns`)
dropped the `interaction_pending` wake that announces a new question card, and
nothing sent it again, so the engineer who asked waited for hours or days. Now
such a wake passes the daily run limit when its card is still pending and
addressed to that agent. The bypass is bounded to 50 wakes per agent per UTC day
(`runtime_config.heartbeat.maxDailyInteractionWakes` overrides it); the daily
cost limit still applies. The bypass was chosen over parking the run until the
midnight reset because that could keep a question waiting for up to a day.

A new scheduler sweep covers any other lost wake: a card that is still pending
after 30 minutes, whose addressee has no live run on the task and no wake for
the card in flight, wakes the addressee again, at most once per card per
30 minutes.

## changelog-ru

### Карточка с вопросом будит адресата, даже если суточный лимит прогонов исчерпан

Агент, исчерпавший суточный лимит прогонов (`runtime_config.heartbeat.maxDailyRuns`),
отбрасывал побудку `interaction_pending`, которая сообщает о новой карточке с
вопросом, и повторной побудки не было: инженер, задавший вопрос, ждал часы и
дни. Теперь такая побудка проходит мимо суточного лимита прогонов, если карточка
всё ещё ожидает ответа и адресована этому агенту. Обход ограничен 50 побудками
на агента за сутки UTC (меняется параметром
`runtime_config.heartbeat.maxDailyInteractionWakes`); суточный лимит расходов
продолжает действовать. Обход выбран вместо переноса прогона до сброса лимита в
полночь: перенос мог продержать вопрос без ответа до суток.

Новая сверка планировщика закрывает прочие потерянные побудки: если карточка
остаётся ожидающей более 30 минут, у адресата нет живого прогона по задаче и
нет побудки по карточке в пути, адресат будится снова, не чаще раза в 30 минут
на карточку.
