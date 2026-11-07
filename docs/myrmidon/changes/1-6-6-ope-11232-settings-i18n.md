## changelog-en

### Run queue priority and shared bot mount panels speak Russian and English (1.6.6 SETTINGS-UI, OPE-11232, OPE-11233)

- The "Run queue priority" and "Shared bot mount" panels of Instance settings now take every visible string (titles, field captions, hints, buttons, validation messages) from the RU/EN catalogs. Before, they were hard-coded in English. The field captions name each weight in words instead of showing the internal field key.
- Behaviour is unchanged: the instance administrator can still set the shared directory path, and the server does not restrict `hostPath`.

## changelog-ru

### Панели «Приоритет очереди прогонов» и «Общий каталог ботов» на русском и английском (1.6.6 SETTINGS-UI, OPE-11232, OPE-11233)

- В настройках экземпляра панели приоритета очереди прогонов и общего каталога ботов берут все видимые строки (заголовки, подписи полей, подсказки, кнопки, сообщения о проверке) из каталогов RU/EN. Раньше тексты были зашиты по-английски. Подписи полей называют каждый вес словами, а не показывают внутренний ключ поля.
- Поведение не меняется: администратор экземпляра по-прежнему задаёт путь общего каталога, сервер `hostPath` не ограничивает.

## divergence-new

### 1.6.6 — SETTINGS-UI: RU/EN для панелей приоритета очереди и общего каталога ботов (OPE-11232, OPE-11233)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-SETTINGS-UI-I18N-CORE | Видимые строки панелей `RunPrioritySettingsPanel` и `SharedMountSettingsPanel` вынесены в каталоги областей `settings-models-runtime-2` и `settings-bots-host-2`; панели добавлены в списки `guarded` | `ui/src/components/myrmidon/RunPrioritySettingsPanel.tsx`, `ui/src/components/myrmidon/SharedMountSettingsPanel.tsx`, `ui/src/i18n/myrmidon-locales/areas/settings-models-runtime-2.*.json`, `ui/src/i18n/myrmidon-locales/areas/settings-bots-host-2.*.json`, `ui/src/i18n/guarded/settings-models-runtime-2.txt`, `ui/src/i18n/guarded/settings-bots-host-2.txt` | Панели, влитые в #2435 (OPE-11244), показывали английский текст при русском интерфейсе | `ui/src/components/myrmidon/InstanceCoreSettingsI18n.myrmidon.test.tsx`, `ui/src/i18n/legacy-screens-no-english.myrmidon.test.ts`, `ui/src/i18n/myrmidon-area-catalogs.myrmidon.test.ts` | Никогда, наше поведение. | заменяет #2451 и #2447 |
