## changelog-en

### PROCS-1.3: inter-process bus over Postgres LISTEN/NOTIFY (OPE-5410 ч.A)

- New `server/src/services/process-bus.ts` — the single bus the
  multi-process board design (OPE-5394 §3) routes through: one
  `sql.listen` per channel over postgres.js (its connection re-LISTENs
  itself after a reconnect and the `onlisten` callback becomes the
  `onReconnect` catch-up hook for subscribers), `publish` via
  `pg_notify`, an `origin = bootId` on every message so a process drops
  its own, a `schemaVersion` stamp validated on receive, and a hard
  refusal of any payload above the 8000-byte NOTIFY limit
  (`ProcessBusPayloadTooLargeError`).
- Channels: `run_queued`, `run_control`, `settings_changed`,
  `live_event`, `secrets_changed`, `bot_apply_requested`,
  `leader_changed`, wire-named `paperclip_bus_<channel>`.
- Default behavior is unchanged: nothing constructs or starts the bus
  until a later task (dispatcher, settings appliers) wires it behind the
  process-role profile.
- Unit tests cover the origin filter, the reconnect catch-up, the
  payload limit, the schemaVersion drop, malformed payloads, and the T6
  lost-NOTIFY case: a dropped signal is picked up by the periodic
  fallback sweep, with no double start once the fast path works again.

## changelog-ru

### PROCS-1.3: шина между процессами через Postgres LISTEN/NOTIFY (OPE-5410 ч.A)

- Новый `server/src/services/process-bus.ts` — единственная шина
  многопроцессной доски (design OPE-5394 §3): `sql.listen` на канал
  через postgres.js (его соединение само переподключается и заново
  делает LISTEN, а колбэк `onlisten` становится догоном `onReconnect`
  для подписчиков), `publish` через `pg_notify`, поле `origin = bootId`
  в каждом сообщении (получатель пропускает свои), штамп
  `schemaVersion` с проверкой на приёме и отказ отправлять payload
  больше 8000 байт (`ProcessBusPayloadTooLargeError`).
- Каналы: `run_queued`, `run_control`, `settings_changed`,
  `live_event`, `secrets_changed`, `bot_apply_requested`,
  `leader_changed`; имена в Postgres — `paperclip_bus_<канал>`.
- Поведение по умолчанию не меняется: шину никто не создаёт и не
  запускает, пока следующие задачи (диспетчер, применители настроек) не
  подключат её за профилем роли процесса.
- Unit-тесты: origin-фильтр, догон после переподключения, предел 8000
  байт, отброс чужого schemaVersion и битых payload, и сценарий Т6 —
  потерянное NOTIFY подбирается периодическим фолбэком, двойного старта
  нет.
