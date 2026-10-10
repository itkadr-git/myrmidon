## changelog-en

### Plugin registry: connectors stay fail-closed by default; the agent permission-mode selector is pinned to three modes (PLUGIN-REGISTRY 3/3)

- Connector fail-closed properties (upstream #13758 pattern) are now pinned by
  tests in `server/src/__tests__/bundled-plugins.test.ts`
  (`describe("connector fail-closed properties")`):
  1. A self-hosted instance with no managed config auto-installs exactly
     `SELF_HOSTED_AUTO_INSTALL_KEYS = ["kubernetes"]`; the other six catalog
     entries (cloudflare, daytona, e2b, exe-dev, modal, novita) are never
     installed or loaded implicitly — not via `installPlugin`, not via the
     lifecycle loader, not even via a registry query.
  2. `ensureBundledPlugins` can never deinstall anything: the provisioner
     dependency surface exposes no uninstall/unload/remove capability, and
     with every connector already present, ensuring only `kubernetes`
     produces zero registry writes, zero lifecycle calls, and queries only
     its own key. Removing a connector or plugin record stays an explicit
     operator action in the plugin registry UI/API. No entitlement behavior
     changed: the myrmidon(PLUGIN-ENTITLEMENT C) gate in the plugin loader
     remains the only intersection point and was left intact.
- The agent card's "Permission mode" selector maps onto the three existing
  `permissionMode` values only: `approve-all` (full auto), `approve-reads`
  (restricted, the ACPX default), `deny-all` (forbidden). The operator-facing
  ACPX labels were renamed accordingly ("Allow Paperclip reads" →
  "Restricted (approve reads)", "Deny all" → "Deny all (forbidden)"); the
  runtime values are unchanged. The vendor's fourth mode
  (`approve-paperclip`) is deliberately not offered — it names vendor tools
  that do not exist in Myrmidon, and any such unknown value still fails
  closed to the provider default.
- Conscious Myrmidon defaults stay untouched: ACPX `approve-reads`, OpenCode
  `ask`, Codex `never`.
- The selector's hint now states explicitly that the chosen mode cannot
  relax the myrmidon(1.6-AUTONOMY) role × action-class gate: that server-side
  gate is stronger than any UI mode and denies or holds actions
  independently of this setting.

## changelog-ru

### Реестр плагинов: коннекторы закрыты по умолчанию; селектор режима прав агента закреплён на трёх режимах (PLUGIN-REGISTRY 3/3)

- Fail-closed свойства коннекторов (образец вендора #13758) закреплены
  тестами в `server/src/__tests__/bundled-plugins.test.ts`
  (`describe("connector fail-closed properties")`):
  1. self-hosted инстанс без managed-конфига авто-устанавливает ровно
     `SELF_HOSTED_AUTO_INSTALL_KEYS = ["kubernetes"]`; остальные шесть
     записей каталога (cloudflare, daytona, e2b, exe-dev, modal, novita)
     не устанавливаются и не загружаются неявно — ни через `installPlugin`,
     ни через lifecycle-загрузчик, ни даже через запрос к реестру.
  2. `ensureBundledPlugins` не может ничего деинсталлировать: поверхность
     зависимостей провижинера не содержит uninstall/unload/remove-возможности,
     а при уже присутствующих коннекторах ensure только `kubernetes` даёт
     ноль записей в реестр, ноль lifecycle-вызовов и запрос только по своему
     ключу. Удаление записи коннектора/плагина остаётся явным действием
     оператора в UI/API реестра плагинов. Поведение entitlement не менялось:
     гейт myrmidon(PLUGIN-ENTITLEMENT C) в plugin-loader — единственная точка
     сверки — сохранён без обхода.
- Селектор «Режим прав» на карточке агента отображается ровно на три
  существующих значения `permissionMode`: `approve-all` (полный автомат),
  `approve-reads` (ограниченный, дефолт ACPX), `deny-all` (запрет).
  Операторские подписи ACPX переименованы («Allow Paperclip reads» →
  «Restricted (approve reads)», «Deny all» → «Deny all (forbidden)»);
  значения рантайма не изменились. Четвёртый вендорский режим
  (`approve-paperclip`) сознательно не предлагается — он называет тулзы
  вендора, которых в Myrmidon нет, и неизвестное значение по-прежнему
  падает закрытым образом к умолчанию провайдера.
- Сознательные умолчания Myrmidon не тронуты: ACPX `approve-reads`,
  OpenCode `ask`, Codex `never`.
- Подсказка у селектора теперь явно говорит, что выбранный режим не может
  ослабить гейт myrmidon(1.6-AUTONOMY) «роль × класс действия»: серверный
  гейт сильнее любого режима из UI и отказывает/удерживает действия
  независимо от этой настройки.
