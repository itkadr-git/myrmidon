---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Bots' Hermes local memory behind an instance switch (MEMORY-CENTRAL-A)

- `MYRMIDON_BOT_LOCAL_MEMORY_OFF` (off by default): when set truthy (`1`/`true`/`yes`/`on`), every bot container's compiled `hermes/config.yaml` gets `memory.memory_enabled: false` and `memory.user_profile_enabled: false` — the vendor flags behind the built-in MEMORY.md/USER.md file stores — so a bot's durable memory lives only in the shared hindsight service. `memory.provider: "hindsight"` and the hindsight rule (mode `local_external`, never cloud) are unchanged either way.
- Off (or an unrecognized value — a typo must not silently disable a bot's memory) the memory block compiles byte-for-byte as before, so turning the switch off restores the previous restartHash and needs no bot restart beyond the normal config change.
- Carrying over the existing bots' local memory files into hindsight is a separate operator step and not part of this change.

## changelog-ru

### Локальная память hermes у ботов за общей настройкой (MEMORY-CENTRAL-A)

- `MYRMIDON_BOT_LOCAL_MEMORY_OFF` (по умолчанию выключена): при истинном значении (`1`/`true`/`yes`/`on`) в собираемый `hermes/config.yaml` каждого контейнера бота пишутся `memory.memory_enabled: false` и `memory.user_profile_enabled: false` — вендорские флаги встроенных файловых хранилищ MEMORY.md/USER.md, — так что долговременная память бота живёт только в общем сервисе hindsight. `memory.provider: "hindsight"` и правило hindsight (режим `local_external`, никогда облако) не меняются ни при каком значении.
- Выключенная настройка (или нераспознанное значение — опечатка не должна молча отключать память бота) собирает блок памяти байт в байт как раньше, поэтому обратное переключение восстанавливает прежний restartHash.
- Перенос уже накопленных локальных файлов памяти ботов в hindsight — отдельный шаг оператора, в этот change не входит.

## settings-en

| `MYRMIDON_BOT_LOCAL_MEMORY_OFF` | MEMORY-CENTRAL-A | unset (off) | Turns every bot container's Hermes LOCAL memory off: the compiled `hermes/config.yaml` gets `memory.memory_enabled: false` and `memory.user_profile_enabled: false` (the built-in MEMORY.md/USER.md stores), so durable memory lives only in the shared hindsight service; `memory.provider: "hindsight"` and its `local_external` mode are unchanged. Read at every profile build — a change restarts bot containers (`config.yaml` is a "restart"-class file) | `1`/`true`/`yes`/`on` — disable local memory. Unset, empty, `0`, `false` or a typo — local memory stays on (the pre-feature config byte for byte, so the restartHash reverts) |
