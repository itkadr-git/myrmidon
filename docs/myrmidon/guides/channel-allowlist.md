# Channel allowlist — who may write to the bots

myrmidon(CA-A), release 1.6.6, track 4. Owner decision 06.10 (OPE-4949):
admission of Telegram (and any future channel) writers is a setting on the
board, decided by the channel identity — a board account is optional. This
guide is the owner-facing half; the Russian version sits next to it
(`channel-allowlist.ru.md`).

## What it does

The board keeps a list of people who may write to the company's bots. The
list is separate from company membership: an admitted person does not need a
board account at all. Admission is keyed by the channel identity — the
numeric Telegram user id — and matched by @username as well (case- and
@-insensitive). Each row covers either **all bots of the company** or **one
specific bot endpoint**; a revoked row never admits but stays visible for
audit.

Two modes decide who is served (Settings → Channel allowlist, or
`PATCH /api/myrmidon/channel-settings` with `channelAccessMode`):

- `sponsor` — the vendor default: an unlinked sender is served when the
  bot's endpoint sponsors guests. Nothing changes from earlier releases.
- `allowlist` — the owner's rule: linked board members write as always, an
  unlinked person writes **only when the allowlist admits them**, and guest
  sponsorship no longer admits anyone.

The mode is read on every message — switching it applies without a restart.
`MYRMIDON_CHANNEL_ACCESS_MODE` pins the value over the board setting.

## A stranger writes

Nobody serves the message:

1. the sender gets one line back, without details:
   «Доступ к этому боту не предоставлен. Запрос передан владельцу.»;
2. the owner (or the admin tier, then operator) gets a board card
   «Запрос доступа к боту от @user» with the sender's channel id and
   @username — exactly what you need to admit them;
3. the journal records `channel_allowlist.access_requested`.

One card and one notice per sender per UTC day: a flood of messages from the
same stranger costs you one decision, not a hundred cards.

## Admitting someone

Open **Settings → Channel allowlist** («Кто может писать ботам»):

- **Admit a person**: choose the channel (telegram), paste the channel id
  (from the access-request card, or ask the person — it is the numeric id;
  the Bot sees it on every message), optionally the @username and the scope
  (all bots or one bot). A board-account link can be attached later when the
  person gets one — admission never waits for it.
- **Revoke** removes the admission at once (the next message is refused);
  the row stays in the list marked «revoked» until restored or deleted.

Everything on this screen is journalled (`channel_allowlist.created` /
`.updated` / `.revoked`), board-only and company-scoped.

## What this part does NOT do yet

The parts B–D of OPE-4949 add: the rights of a writer (questions only /
create tasks / approve cards / manage bots) enforced per action, approve-or-
deny buttons on the access-request card itself, and the full per-message
audit mark. Until Part B lands, an admitted person writes with the same
capabilities the vendor gives a served sender — the allowlist decides
*whether* they are served, not *what* they may do.

## Verifying it

Tests: `server/src/myrmidon/channel-allowlist/channel-allowlist.myrmidon.test.ts`
(matching, mode resolution, routes) and the «channel allowlist (CA-A)»
suite inside
`server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts`
(full inbound pipeline on postgres: refuse-and-card, admitted sender served,
handle match, revoke, daily dedupe, sponsor mode unchanged).
