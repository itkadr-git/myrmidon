# Telegram bridge: service texts follow your language (TG-LOCALE)

> Русская версия: [telegram-bridge-locale.ru.md](telegram-bridge-locale.ru.md)

The bridged Telegram DM (enabled per endpoint with
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) answers in the language of the linked
board user. Command replies (`/help`, `/model`, `/think`, `/stop`, `/status`,
`/plan`), refusals ("this chat is not available", the unlinked-account
refusal), the migration notice and every other service text come from
server-side locale catalogs, not from hardcoded strings.

## How the language is chosen

Highest first:

1. **Environment force** — `MYRMIDON_TELEGRAM_DM_LANGUAGE=en|ru` pins one
   language for the whole instance, for every chat and for the Telegram
   command menu. This is an operator override only; normal use needs no env.
   Any other value is ignored.
2. **Your own choice** — the language saved on the board's Settings →
   Language screen (the per-user `user_ui_language` row). It is read again on
   every message, so switching languages takes effect on the bot's very next
   reply: no restart, no reconnect.
3. **English** — the fork default for users who never chose, and for
   Telegram accounts that are not linked to a board user (the unlinked
   refusal is sent in English, subject to the env force).

## The Telegram command menu

Telegram shows one private-chat command menu per bot, not per user, so the
menu follows the instance decision only: the env force if set, otherwise
English. Personal replies still follow each user's own language.

## Seeing the source of the value

The Settings → Language screen shows, under the choice, whether the Telegram
bot follows your preference or is pinned by the server environment (with the
pinned language named). The source is recomputed on every read, so the screen
is truthful without a restart. The same preference row is written by the
language switch in the account menu of the current interface, so both
surfaces set one value.

## Catalog layout

- `server/src/myrmidon/agent-chat-bridge/locales/en.ts` — the base catalog
  (English; every key is defined here).
- `server/src/myrmidon/agent-chat-bridge/locales/ru.ts` — Russian, key-for-key
  parity with English (a test guards it; placeholders must match too).
- `server/src/myrmidon/agent-chat-bridge/locales/index.ts` — locale selection
  and the `t(locale, key, params)` renderer.

A ratchet test (`locales-ratchet.myrmidon.test.ts`) fails CI if a Cyrillic
string literal appears in bridge code outside the catalogs, so new service
text cannot silently skip localization. Identifiers are not prose: command
names, model ids and reasoning levels are never translated.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `MYRMIDON_TELEGRAM_DM_LANGUAGE` | Forces `en` or `ru` for all bridged Telegram DM texts and the command menu, instance-wide | unset — per-user preference with English default |
