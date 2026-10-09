## changelog-en

### Settings UI: document signing re-enable on the Browsers page (SETTINGS-UI C-3)

- The Browsers settings page now shows whether document signing is on. The
  block reads the bridge settings (`GET /api/myrmidon/browser-bridge/settings`)
  and says either that signing is on and the bridge signs under the policy of
  the connector panel, or that an emergency stop turned it off and every sign
  action is refused until it is turned back on.
- While signing is off, the block offers "Re-enable signing": the button opens
  a confirmation step first, and only the confirm writes — `PATCH
  /api/myrmidon/browser-bridge/settings` with `signing.enabled: true` plus the
  mode, types and daily limit that are stored right now, so a re-enable never
  rewrites the signing policy behind the operator's back. Cancel closes the
  step and writes nothing.
- The stored settings are re-read after a successful write, a write in flight
  disables the confirm and the cancel button, and a failed write is reported in
  the block while the displayed state stays as read.
- This is the operator counterpart of the kill switch in the connector panel
  (`POST /api/myrmidon/browser-bridge/signing/disable`), which until now could
  only be undone by hand-editing the instance settings row. Nothing on the
  server side changed: the settings `PATCH` already accepted `enabled: true`,
  and the bridge keeps auditing the change of `enabled` exactly as before.
- The block stays on screen while the browser registry is loading or has
  failed, so a stopped bridge is visible on the page even when the registry
  cannot be read; a failed read of the bridge settings is shown inside the
  block and does not take the registry down with it.

## changelog-ru

### Настройки: возврат подписи документов на странице «Браузеры» (SETTINGS-UI C-3)

- Страница настроек «Браузеры» теперь показывает, включена ли подпись
  документов. Блок читает настройки моста (`GET
  /api/myrmidon/browser-bridge/settings`) и пишет одно из двух: подпись
  включена и мост подписывает по политике из панели коннектора, либо
  аварийное выключение её сняло и любое действие подписи отклоняется, пока её
  не включат обратно.
- Пока подпись выключена, в блоке есть кнопка «Включить подпись обратно»: она
  сначала открывает шаг подтверждения, и запись делает только подтверждение —
  `PATCH /api/myrmidon/browser-bridge/settings` с `signing.enabled: true` и
  теми режимом, типами и суточным лимитом, которые сохранены сейчас, так что
  возврат подписи не переписывает политику за спиной оператора. Отмена
  закрывает шаг и ничего не пишет.
- После успешной записи настройки перечитываются, на время записи кнопки
  подтверждения и отмены заблокированы, а неудачная запись показывается в
  блоке, не меняя отображённое состояние.
- Это операторская пара к аварийному выключателю в панели коннектора (`POST
  /api/myrmidon/browser-bridge/signing/disable`), который до сих пор можно было
  снять только ручной правкой строки настроек инстанса. На стороне сервера
  ничего не менялось: настройки `PATCH` уже принимали `enabled: true`, и мост
  по-прежнему журналирует смену `enabled`.
- Блок остаётся на экране и пока реестр браузеров грузится или его не удалось
  прочитать, поэтому остановленный мост видно на странице даже при недоступном
  реестре; неудачное чтение настроек моста показывается внутри блока и не
  утаскивает за собой реестр.