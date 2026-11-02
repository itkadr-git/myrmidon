---
settings-section: Track 1 — platform
---

## changelog-en

### Closed self-registration by default (OPE-8649)
- Self-registration without an invitation is rejected unless explicitly enabled.
- Configure `MYRMIDON_AUTH_DISABLE_SIGN_UP=false` to allow public credential sign-up; the default is closed.

## changelog-ru

### Саморегистрация закрыта по умолчанию (OPE-8649)
- Саморегистрация без приглашения отклоняется, если её явно не включить.
- Для разрешения регистрации по логину и паролю задайте `MYRMIDON_AUTH_DISABLE_SIGN_UP=false`; по умолчанию регистрация закрыта.

## settings-en

| `MYRMIDON_AUTH_DISABLE_SIGN_UP` | OPE-8649 | `true` (closed) | Controls public credential self-registration; without an explicit setting, signup is rejected | Set `false` to allow signup; legacy `PAPERCLIP_AUTH_DISABLE_SIGN_UP` remains supported |

## settings-ru

| `MYRMIDON_AUTH_DISABLE_SIGN_UP` | OPE-8649 | `true` (закрыта) | Управляет саморегистрацией по логину и паролю; без явной настройки регистрация отклоняется | Для разрешения задайте `false`; legacy `PAPERCLIP_AUTH_DISABLE_SIGN_UP` поддерживается |
