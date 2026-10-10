## settings-en-new

<!-- after: 1.6.2 — PLUGIN-ENTITLEMENT C: plugin entitlement keys (instance settings UI) -->
### 1.6.3 — PLUGIN-ENTITLEMENT A: ed25519 verification of instance plugin keys

Entitlement keys are verified cryptographically since 1.6.3: a key is a signed ed25519 token
(`PEK1.<payload>.<signature>`, payload `{pluginId, instanceId, expiresAt}`), checked on acceptance
and re-checked by the loader gate on every activation pass — rotating the verification key
invalidates previously accepted keys. A rejected key answers 400 with the reason only (bad
signature, expired, wrong instance, wrong plugin, no verification key configured).

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `pluginEntitlementPublicKey` | 1.6.3-PLUGIN-ENTITLEMENT A | absent | The ed25519 public key (PEM) used to verify entitlement keys; absent means no token can verify and every entitlement-gated plugin stays inactive (fail closed) | Change it in the "Plugin keys" block of the instance settings page or via `PUT …/public-key`; `GET …/public-key` reports the effective value and whether it comes from the settings row or the env override; the panel shows that source. `MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY` (PEM, or base64 of the raw 32-byte key) is a forced override, applied only while the settings row is empty |

## settings-en-append

<!-- after-line: applies without a restart — the loader gate re-reads the row on every -->
activation pass. No env override for the key list: which plugins are unlocked is
a licensing choice, not a deployment knob. Since 1.6.3 (PLUGIN-ENTITLEMENT A)
the key itself is verified cryptographically: the key is a signed ed25519 token
(`PEK1.<payload>.<signature>`, payload `{pluginId, instanceId, expiresAt}`) and
the verification public key is an instance setting
(`pluginEntitlementPublicKey`), rotatable in the UI without a restart. An
invalid input answers 400 with a clear message.

## divergence-new

### 1.6.3 — PLUGIN-ENTITLEMENT A: криптографическая проверка ключей экземпляра (сервер)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.3-PLUGIN-ENTITLEMENT-A | Криптографическая проверка ключей включения плагинов поверх слитой модели 1.6.2-C: ключ — подписанный ed25519-токен `PEK1.<payload base64url>.<подпись base64url>` с payload `{pluginId, instanceId, expiresAt}` (строгая схема, срок только из подписанного payload). Верификатор `verifyEntitlementToken` стоит на двух путях: приём ключа (POST …/keys, до сохранения) и гейт загрузчика (перепроверка подписи на каждом проходе активации — ротация открытого ключа обесценивает ранее принятый ключ). Открытый ключ проверки — настройка экземпляра `pluginEntitlementPublicKey` (PEM ed25519): `GET/PUT /api/myrmidon/plugin-entitlement/public-key` (instance-admin) возвращает значение и источник (`settings`/`env`/`none`), UI-блок «Ключи плагинов» показывает источник и меняет ключ без перезапуска; env `MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY` — только принудительное переопределение, когда в настройках пусто. Отказы (неверная подпись, истёк, другой экземпляр, другой плагин, ключа проверки нет) — 400 с понятной причиной, без материала ключа; список ключей по-прежнему без значений | Новые: `packages/shared/src/myrmidon-plugin-entitlement.ts` (токен/схема/проекция + `pluginEntitlementPublicKeyViewSchema`), `server/src/myrmidon/plugin-entitlement/validation.ts` (токен-парсер, ed25519-верификатор, проверка ключа), `store.ts` (чтение/запись ключей и открытого ключа в general-строке, источник значения), `routes.ts` (accept/list/remove + GET/PUT public-key), `index.ts` (barrel), `server/src/services/plugin-entitlement-enforcement.ts` (решение гейта с подписью), `server/src/myrmidon/plugin-entitlement/plugin-entitlement.myrmidon.test.ts` (тесты подписи/гейта/ключа). Аддитивно в вендорских: `pluginEntitlementPublicKey` в general-схему и тип (`packages/shared/src/validators/instance.ts`, `types/instance.ts`), preserve+импорт в `server/src/services/instance-settings.ts`, контекст верификации в гейте `server/src/services/plugin-loader.ts` (2 правки), строки `pluginEntitlement.*` в `ui/src/i18n/myrmidon-locales/{en,ru}.json`, поле открытого ключа и сообщение об отказе в `ui/src/components/myrmidon/{PluginEntitlementSettingsPanel.tsx,pluginEntitlementApi.ts,PluginEntitlementSettingsPanel.myrmidon.test.tsx}`, доки `docs/myrmidon/guides/plugin-entitlement-keys{,.ru}.md` и `docs/myrmidon/SETTINGS.md` | Эпик 1.6.2/1.6.3 PLUGIN-ENTITLEMENT, часть A (сервер): закрыть ML1/ML2-заглушку и принимать только ключи с верной подписью | `packages/shared/src/myrmidon-plugin-entitlement.myrmidon.test.ts` (формат токена и строгая схема payload, нормализация списка, проекция без значений ключей, контракт ответа с открытым ключом), `server/src/myrmidon/plugin-entitlement/plugin-entitlement.myrmidon.test.ts` (подпись: верная проходит, чужая/другой экземпляр/другой плагин/истёкший/нет ключа проверки — отказ с причиной; гейт активации с ре-верификацией; источник открытого ключа settings/env/none; запись и очистка ключа; принимается только ed25519-PEM; форма ответа списка без значений), `ui/src/components/myrmidon/PluginEntitlementSettingsPanel.myrmidon.test.tsx` (причина отказа из сервера в интерфейсе, источник открытого ключа, сохранение открытого ключа) | Никогда, наше поведение; уходит вместе с эпиком PLUGIN-ENTITLEMENT (снять каталог `server/src/myrmidon/plugin-entitlement/`, `pluginEntitlementPublicKey` из general и его env-переопределение, поле открытого ключа и строки локализации) | (этот PR) |
