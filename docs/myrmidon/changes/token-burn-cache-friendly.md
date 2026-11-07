---
divergence-section: 1.6.1 — BOT-RUNTIME-TUNING, часть B: компилятор профиля
settings-section: Track 5 — operations
---

## changelog-en

### Bot input tokens: keep the provider prompt cache, bound what is new (TOKEN-BURN)

Quotas are consumed by fresh (uncached) input and by output, and a provider cache hits only on a byte-identical
prefix, so rewriting a message that was already sent turns the rest of the context into fresh input. The bot
runtime (patches `16`, `25`, `26`, `27`) now bounds what is new and what is rebuilt, and rewrites nothing
in the middle of a session. Every setting is a key of the `context_economy:` block of the bot's `config.yaml`
(environment `HERMES_CONTEXT_ECONOMY_<KEY>` overrides it).

- **Not rewritten any more.** Superseded wake messages (A) and stale tool results (B) are no longer replaced in the
  request by default (`stale_wakes`, `stale_tool_results`: `false`). Measure A had also gone dead at the product
  rename (it recognised only the identity head from before the rename); it now recognises both heads, and a build
  check ties the patch to the adapter's wording. `skill_view` results and reads of skill files are never replaced
  when B is on.
- **New huge results are cut once, when they are produced.** A tool result of more than `tool_result_max_chars`
  (16000) is stored and sent as its first 8000 and last 4000 characters plus a marker with the path of the spill file
  holding the whole text and how to read the middle (`read_file` offset, byte offsets, or a filtered re-run).
  `read_file` stays pinned by upstream, `skill_view` is exempt (`tool_result_exempt`).
- **The compaction is cheaper and keeps the cached prefix.** The summary is asked for at most
  `compaction_summary_max_chars` (8000) characters with `compaction_summary_max_tokens` (6144) as the call's output
  limit; a summary that stopped on the output limit is kept (cut at a line end) instead of failing the compression;
  board wake packages are not quoted into the summarizer input or the verbatim user messages; the anchor index and
  the verbatim user messages are bounded; the system prompt and the tool schemas are not rebuilt at a compaction
  (`compaction_keep_prefix`), so the prefix after it is the prefix before it.

## changelog-ru

### Входные токены ботов: беречь кэш промпта провайдера, ограничивать новое (TOKEN-BURN)

Квоты расходуются свежим (некэшированным) входом и выводом, а кэш провайдера срабатывает только на побайтно
совпадающий префикс: правка уже отправленного сообщения делает остаток контекста свежим входом. Рантайм ботов
(патчи `16`, `25`, `26`, `27`) теперь ограничивает новое и пересобираемое и ничего не переписывает посреди сессии.
Все настройки — ключи блока `context_economy:` в `config.yaml` бота (переменная `HERMES_CONTEXT_ECONOMY_<KEY>`
перекрывает файл).

- **Больше не переписывается.** Устаревшие wake-сообщения (A) и устаревшие результаты инструментов (B) по умолчанию
  не заменяются в запросе (`stale_wakes`, `stale_tool_results`: `false`). Мера A к тому же перестала срабатывать
  после переименования продукта (узнавала только шапку идентичности, действовавшую до переименования): теперь узнаёт обе
  шапки, а проверка сборки связывает патч с формулировкой адаптера. Результаты `skill_view` и чтение файлов навыков
  при включённой B не заменяются никогда.
- **Новые огромные результаты режутся один раз, при появлении.** Результат инструмента длиннее
  `tool_result_max_chars` (16000) хранится и отправляется как первые 8000 и последние 4000 символов плюс пометка с
  путём файла, где лежит весь текст, и способом прочитать середину (`read_file` с offset, байтовые смещения или
  повторный запуск с фильтром). `read_file` закреплён апстримом, `skill_view` исключён (`tool_result_exempt`).
- **Компакция дешевле и сохраняет закэшированный префикс.** Сводку просят не длиннее `compaction_summary_max_chars`
  (8000) символов, лимит вывода вызова — `compaction_summary_max_tokens` (6144); сводка, оборванная по лимиту вывода,
  сохраняется (обрезается по концу строки) вместо провала сжатия; wake-пакеты доски не цитируются ни во входе
  суммаризатора, ни в дословных сообщениях пользователя; индекс якорей и дословные сообщения ограничены; системный
  промпт и схемы инструментов при компакции не пересобираются (`compaction_keep_prefix`), поэтому префикс после неё
  равен префиксу до неё.

## divergence

| TOKEN-BURN | Рантайм бота не переписывает уже отправленные сообщения (меры A и B выключены по умолчанию, узнавание wake-сообщений исправлено), режет один раз новые результаты инструментов длиннее 16000 символов (первые 8000 + последние 4000 + пометка с путём файла), ограничивает сводку компакции 8000 символами (лимит вывода вызова, обрезка по строке, оборванная по длине сводка сохраняется) и не пересобирает системный промпт и схемы инструментов при компакции | `docker/bot-runtime/patches/16-context-economy.patch`, `25-tool-result-head-tail.patch` (`tools/tool_result_storage.py`), `26-compaction-summary-cap.patch` (`agent/context_compressor.py`), `27-compaction-keep-prefix.patch` (`agent/conversation_compression.py`) | Квоты расходуются свежим входом и выводом; кэш провайдера срабатывает на побайтно совпадающий префикс, поэтому правка отправленного сообщения и пересборка префикса стоят дороже, чем сэкономленные токены | `docker/bot-runtime/tests/context_economy.py`, `tool_result_head_tail.py`, `compaction_summary_cap.py` (сборка образа); `scripts/myrmidon/bot-runtime/dockerfile.test.mjs` (шапка wake-сообщения адаптера) | При появлении в апстриме границы размера результата с головой и хвостом, ограничения сводки компакции и сохранения префикса при компакции | token burn (cache-friendly) |

## settings-en

| `context_economy.tool_result_max_chars` (config.yaml; env `HERMES_CONTEXT_ECONOMY_TOOL_RESULT_MAX_CHARS`) | TOKEN-BURN | `16000` | A new tool result longer than this is stored and sent as its first `tool_result_head_chars` (8000) and last `tool_result_tail_chars` (4000) characters plus a marker naming the spill file with the whole text and how to read the middle. `tool_result_exempt` (default `skill_view`) lists tools that are never cut; `read_file` is pinned by upstream | `0` gives the upstream limits back (100000 characters, preview of 1500) |
| `context_economy.compaction_summary_max_chars` (config.yaml) | TOKEN-BURN | `8000` | Size the compaction summarizer is asked for and held to; `compaction_summary_max_tokens` (6144) is the call's output limit; `compaction_user_messages_max_chars` (6000), `compaction_user_message_max_chars` (1500) and `compaction_anchor_max_chars` (2000) bound the sections appended to the summary; `compaction_stub_wakes` (`true`) keeps board wake packages out of it; `compaction_accept_truncated` (`true`) keeps a summary that stopped on the output limit | `compaction_summary_max_chars: 0` switches the size caps off (the rest stays); `compaction_stub_wakes: false`, `compaction_accept_truncated: false` restore the upstream handling |
| `context_economy.compaction_keep_prefix` (config.yaml) | TOKEN-BURN | `true` | A compaction keeps the system prompt and the tool schemas as they were instead of rebuilding them (memory re-read, plugin sections re-rendered, skills re-listed, MCP tools re-listed), so the cached prefix survives it | `false` restores the upstream rebuild |
| `context_economy.stale_wakes`, `context_economy.stale_tool_results` (config.yaml) | TOKEN-BURN | `false` | Measures A and B (see CONTEXT-ECONOMY): off by default because they rewrite earlier messages and break the provider's prompt cache. `stale_tool_min_chars` (8000), `stale_tool_keep_messages` (8), `stale_tool_step_messages` (8), `stale_tool_exempt` tune B; `skill_view` and reads of skill files are never replaced | `HERMES_KEEP_STALE_WAKES=1` / `HERMES_KEEP_STALE_TOOL_RESULTS=1` force them off |

## settings-ru

| `context_economy.tool_result_max_chars` (config.yaml; env `HERMES_CONTEXT_ECONOMY_TOOL_RESULT_MAX_CHARS`) | TOKEN-BURN | `16000` | Новый результат инструмента длиннее этого значения хранится и отправляется как первые `tool_result_head_chars` (8000) и последние `tool_result_tail_chars` (4000) символов плюс пометка с файлом, где лежит весь текст, и способом прочитать середину. `tool_result_exempt` (по умолчанию `skill_view`) — инструменты, которые не режутся никогда; `read_file` закреплён апстримом | `0` возвращает лимиты апстрима (100000 символов, превью 1500) |
| `context_economy.compaction_summary_max_chars` (config.yaml) | TOKEN-BURN | `8000` | Размер, которого просят у суммаризатора компакции и до которого обрезают ответ; `compaction_summary_max_tokens` (6144) — лимит вывода вызова; `compaction_user_messages_max_chars` (6000), `compaction_user_message_max_chars` (1500) и `compaction_anchor_max_chars` (2000) ограничивают разделы, дописываемые к сводке; `compaction_stub_wakes` (`true`) не пускает в неё wake-пакеты доски; `compaction_accept_truncated` (`true`) сохраняет сводку, оборванную по лимиту вывода | `compaction_summary_max_chars: 0` отключает ограничения размера (остальное остаётся); `compaction_stub_wakes: false`, `compaction_accept_truncated: false` возвращают поведение апстрима |
| `context_economy.compaction_keep_prefix` (config.yaml) | TOKEN-BURN | `true` | Компакция сохраняет системный промпт и схемы инструментов как есть, не пересобирая их (перечитывание памяти, перерисовка секций плагинов, перечень навыков и MCP-инструментов), поэтому закэшированный префикс переживает компакцию | `false` возвращает пересборку апстрима |
| `context_economy.stale_wakes`, `context_economy.stale_tool_results` (config.yaml) | TOKEN-BURN | `false` | Меры A и B (см. CONTEXT-ECONOMY): по умолчанию выключены, потому что переписывают прежние сообщения и ломают кэш промпта провайдера. `stale_tool_min_chars` (8000), `stale_tool_keep_messages` (8), `stale_tool_step_messages` (8), `stale_tool_exempt` настраивают B; `skill_view` и чтение файлов навыков не заменяются никогда | `HERMES_KEEP_STALE_WAKES=1` / `HERMES_KEEP_STALE_TOOL_RESULTS=1` принудительно выключают |
