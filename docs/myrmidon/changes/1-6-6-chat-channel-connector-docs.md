## changelog-en

### Telegram moves out of the core into a channel connector: the design (1.6.6, step 1)

- The design document for release 1.6.6 is approved and recorded in
  [design/chat-channel-connector.en.md](design/chat-channel-connector.en.md)
  (Russian original: [design/chat-channel-connector.md](design/chat-channel-connector.md)):
  everything that knows about Telegram moves into a
  `server/src/myrmidon/channel-connectors/telegram/` connector behind a hub,
  and the vendor `chat-channels.ts` keeps exactly one of our inserts instead
  of today's 66 channel inserts. Connect, configure and disconnect happen in
  the existing Chat endpoints UI with no server restart.
- The owner decisions are fixed in section 11: one on/off switch for the
  whole channel; the shared writer-access layer lands right after the switch,
  in this release; bridge topics move from lower risk to higher risk. The
  move runs as six steps, one PR each, accepted on a production-DB copy.
- This step ships no code: no behavior, settings, or schema changes until the
  implementation steps land.

## changelog-ru

### Telegram выходит из ядра в коннектор канала: проект (1.6.6, шаг 1)

- Проектный документ выпуска 1.6.6 согласован и записан в
  [design/chat-channel-connector.md](design/chat-channel-connector.md)
  (английская версия: [design/chat-channel-connector.en.md](design/chat-channel-connector.en.md)):
  всё, что знает про Telegram, переезжает в коннектор
  `server/src/myrmidon/channel-connectors/telegram/` за хабом, а в
  вендорском `chat-channels.ts` остаётся ровно одна наша вставка вместо
  нынешних 66 канальных. Подключение, настройка и отключение канала — в
  существующем интерфейсе Chat endpoints, без перезапуска сервера.
- Решения владельца зафиксированы в разделе 11: один выключатель на весь
  канал; общий слой прав пишущих входит сразу после выключателя, в этом же
  выпуске; темы моста переносятся от малого риска к большему. Перенос идёт
  шестью шагами, каждый отдельным PR, приёмка — на копии боевой базы.
- Этот шаг не поставляет код: ни поведение, ни настройки, ни схема не меняются
  до шагов реализации.
