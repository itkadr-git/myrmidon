# Telegram DM: editable run status and inline split of long answers

> Russian version: [telegram-dm-status.ru.md](telegram-dm-status.ru.md)

Two opt-in settings change how a bridged Telegram DM (a chat connected with
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) shows a run. Both are off by default;
with both unset the vendor behavior is unchanged.

## Editable run status (`MYRMIDON_TELEGRAM_DM_STATUS`)

By default the bridged DM suppresses the routine run milestones ("queued",
"working") as noise, so the chat owner sees nothing until the agent's answer
arrives. With `MYRMIDON_TELEGRAM_DM_STATUS=1` the run gets exactly one
status message in the DM instead of silence:

- The status is posted once, when the run is queued, and the same message is
  edited in place as the phase changes (`queued` → `working`) — no stack of
  milestone messages.
- The run's final answer replaces the status message.
- Failure, admin-attention and completion milestones still publish as before,
  and the terminal milestone of a turn stopped with `/stop` from the chat
  stays suppressed — the command has already answered.
- The setting is read on every sweep; no restart is needed. Groups and
  topics are unaffected — it applies to bridged DMs only.

Accepted on values: `1`, `true`, `yes`, `on`. Any other value (or unset)
keeps the vendor path unchanged.

### Live progress steps (instance settings)

While the run works, the status message shows what the bot is doing, not only
"working": the current step in plain words ("читаю презентацию deck.pptx",
"правлю слайды 4, 9", "проверяю результат"), the elapsed time, and the last
few finished steps under "Сделано:". The same message is edited in place and
the final answer replaces it.

- **Where the steps come from.** The run's native step events; for adapters
  that write none (Hermes gateway and local), an in-memory step history fed by
  the runtime status and the run-log tool lines. A tool call is turned into a
  short phrase; only a file basename or slide numbers from its argument
  preview may appear, never commands, paths or other arguments.
- **How often it edits.** A milestone change (queued to working) posts at
  once; a change of the step kind (reading, editing, checking) after about
  5 seconds; any other change (a new target of the same kind, the elapsed
  time) only after the interval (15–300 s, default 45 s). Identical text is
  never sent twice.
- **Where to switch it.** Instance settings → General → "Telegram DM: live
  progress" (`GET`/`PATCH /api/myrmidon/telegram-dm-progress`): on/off and the
  interval, applied at the next status update, no restart. Turning it on also
  turns the status message on for bridged DMs. `MYRMIDON_TELEGRAM_DM_PROGRESS`
  and `MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC` force a value; with nothing
  saved the default of "on" follows `MYRMIDON_TELEGRAM_DM_STATUS`.

## Inline split of long answers (`MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS`)

A Telegram message is limited to 4,096 UTF-16 units. Long plain-prose
answers already arrive as several native messages (split at paragraph, line,
then word boundaries, about 1,600 code points per part). A long
**structured** Markdown answer — code fences, tables, lists — is different:
Telegram parses each message as a separate Markdown document, so splitting
would break the formatting, and by default such an answer arrives as one
`.md` file attachment.

With `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS` set to a positive integer, a long
structured answer splits inline into at most that many ordered parts instead
of the attachment. Limits:

- A document that needs more parts than the cap still goes out as one
  attachment — the cap is a ceiling, not a stretch.
- The split is boundary-based (paragraph, line, word); joining the parts
  reconstructs the source text losslessly.
- Unset, `0`, or a value that is not a non-negative integer keeps the
  vendor's single attachment. The setting is read at delivery time; no
  restart is needed.

Both settings live in [../SETTINGS.md](../SETTINGS.md) with defaults and
accepted values.

## Chats are never held; no silent queue (CHAT-HOLD)

A bridged DM is a perpetual conversation, so it is never treated as a work
ticket by recovery:

- **No hold.** When a chat's run is cancelled or crashes (a host OOM, for
  example), recovery does not set the chat issue `blocked` and records no
  "do not replay" hold. The turn is settled as `chat_continuation`; the chat
  returns to waiting for the next message.
- **A message always wakes.** A new message you write in the chat is an
  explicit human action. It passes and lifts any leftover hold (also one from
  before this behavior), moves a `blocked` chat back to `todo`, starts a run,
  and is logged in the activity log. Only the chat's "retry the failed run"
  action is still withheld by a hold.
- **You are told why it waits.** If the message cannot start at once, the bot
  answers in the chat in plain words instead of a bare "queued": the previous
  answer is still finishing, the previous turn was interrupted and is being
  closed, an open question needs your answer, the bot is paused or turned
  off, its budget is used up, or the server is short of memory (checked again
  every 15 seconds). A message that was declined and will not start by itself
  says so and asks to send it again.
