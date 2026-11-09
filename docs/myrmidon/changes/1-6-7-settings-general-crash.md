## changelog-en

### Settings → General no longer crashes on the Runs & Queue panel (SETTINGS-GENERAL-CRASH)

- Fixed: a few seconds after opening Settings → General the page fell to the error screen "values is not iterable". The Runs & Queue panel read a `values[]` array from `GET /api/myrmidon/behavior-settings`, while the server answers `{ settings, sources }` (the contract every other behavior-settings panel uses). The panel now reads that contract; a response of any other shape, or a failed request, is shown as an error inside the panel and never takes the page down. A value typed into a field that cannot be parsed is flagged and not sent.
- Fixed: a non-administrator who opens the Channels or Bot disk settings now sees "Нужны права администратора экземпляра" / "Instance admin access required" (translated) instead of raw English or no message at all.
- Fixed: the swarm "scent" block of Settings → General showed raw `swarmClaim.scent.*` keys; the ru/en strings are added.
- Test: the server contract test now pins that `GET /api/myrmidon/behavior-settings` answers `{ settings, sources }` and carries every runs-queue key; the panel's key list is checked against the registry.

## changelog-ru

### Настройки → Общие больше не падают на панели «Runs & Queue» (SETTINGS-GENERAL-CRASH)

- Исправлено: через несколько секунд после открытия «Настройки → Общие» страница падала в экран ошибки «values is not iterable». Панель Runs & Queue ждала от `GET /api/myrmidon/behavior-settings` массив `values[]`, а сервер отвечает `{ settings, sources }` (контракт, по которому работают остальные панели behavior-settings). Теперь панель читает этот контракт; ответ другой формы или упавший запрос показываются как ошибка внутри панели и не роняют страницу. Введённое в поле значение, которое не разобрать, помечается и не отправляется.
- Исправлено: не-администратор, открывший настройки каналов или диска ботов, видит «Нужны права администратора экземпляра» (по-русски и по-английски) вместо сырого английского текста или пустоты.
- Исправлено: блок «запаха» роя в «Настройки → Общие» показывал сырые ключи `swarmClaim.scent.*`; добавлены строки ru/en.
- Тест: серверный контрактный тест фиксирует, что `GET /api/myrmidon/behavior-settings` отвечает `{ settings, sources }` и содержит все ключи runs-queue; список ключей панели сверяется с реестром.
