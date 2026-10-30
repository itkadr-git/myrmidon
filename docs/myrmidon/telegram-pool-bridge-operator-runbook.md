# Telegram Pool Bridge Operator Acceptance Runbook (1.6.6 MODULE-TELEGRAM)

This runbook guides operators through configuring, verifying, and accepting the Telegram bridge for ChatGPT and Google AI / Gemini pool modules.

---

## 1. Operating Model & Security Invariants

1. **Default Disabled**: The Telegram pool bridge is disabled by default for both modules. It must be explicitly enabled per module by the operator.
2. **Zero Token Printing**: Raw Telegram bot tokens and pool API keys must **never** be printed in shell commands, logs, tickets, or comments. Reference secrets by name or use `<redacted>`.
3. **Chat Allowlist**: Only messages originating from the configured `allowedChatId` (and optional `allowedUserIds`) are accepted. Any message from an unauthorized chat or stranger is refused immediately without calling pool-chat and without debiting quota.
4. **Update Deduplication**: Incoming Telegram updates carry an `update_id`. If Telegram retries webhook delivery with the same `update_id`, the bridge returns the existing result without invoking the upstream pool transport and without charging quota again.
5. **Long Response Handling**: Telegram limits message text to 4096 characters. The bridge splits responses exceeding 4096 characters into chunks of at most 4096 characters (breaking cleanly at paragraph, sentence, or word boundaries) and delivers them sequentially via the outbox.
6. **Isolated History**: ChatGPT and Gemini bridge conversations use isolated conversation IDs (`tg:chatgpt:<chatId>` and `tg:google:<chatId>`). They do not cross each other and never cross web-chat conversations.

---

## 2. Operator Configuration

### Via ChannelSettingsPanel (UI)
1. Navigate to **Instance → General → Channels (Telegram & chat bridges)**.
2. Locate **Telegram Pool Bridges (ChatGPT & Gemini)**.
3. Configure:
   - **Allowed Chat ID**: Specify your test Telegram chat ID (e.g., `123456789`).
   - **Model**: Set desired model (e.g., `balanced` for ChatGPT, `gemini-1.5-pro` for Google AI).
   - **Bridge Toggle**: Keep switch **Off** until ready for testing.
4. Click **Save channel settings**.

### Via Environment Variables (Deployment)
- `MYRMIDON_TELEGRAM_POOL_CHATGPT_ENABLED`: `0` (default) or `1`
- `MYRMIDON_TELEGRAM_POOL_CHATGPT_CHAT_ID`: Allowed chat ID for ChatGPT
- `MYRMIDON_TELEGRAM_POOL_CHATGPT_MODEL`: Default `balanced`
- `MYRMIDON_TELEGRAM_POOL_GEMINI_ENABLED`: `0` (default) or `1`
- `MYRMIDON_TELEGRAM_POOL_GEMINI_CHAT_ID`: Allowed chat ID for Gemini
- `MYRMIDON_TELEGRAM_POOL_GEMINI_MODEL`: Default `gemini-1.5-pro`

Bot tokens are mounted into the secret store or environment via secret references:
- ChatGPT bot token secret: `telegram-pool-chatgpt-token`
- Gemini bot token secret: `telegram-pool-gemini-token`

---

## 3. Operator Live Verification Procedure

### Step 1: Verify Default Disabled
Send a test update when bridge is disabled:
```bash
# Verify update is ignored with status "ignored" and reason "bridge_disabled"
curl -s -X POST "http://localhost:3100/api/myrmidon/pool-chat/modules/<MODULE_ID>/telegram/webhook" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1001,"message":{"message_id":1,"chat":{"id":123456789},"text":"ping"}}'
```
Expect response:
```json
{"status":"ignored","reason":"bridge_disabled","updateId":1001}
```
No quota reservation or pool transport call should occur.

### Step 2: Enable Bridge & Verify Allowlist Refusal
Enable the bridge with `allowedChatId: 123456789`.
Send a test message from an unauthorized chat (`999999999`):
```bash
curl -s -X POST "http://localhost:3100/api/myrmidon/pool-chat/modules/<MODULE_ID>/telegram/webhook" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1002,"message":{"message_id":2,"chat":{"id":999999999},"text":"unauthorized"}}'
```
Expect response:
```json
{"status":"refused","reason":"chat_not_allowed","updateId":1002,"chatId":999999999}
```
Verify that no upstream request was created and no quota was debited.

### Step 3: Verify Authorized Processing
Send a test message from authorized chat (`123456789`):
```bash
curl -s -X POST "http://localhost:3100/api/myrmidon/pool-chat/modules/<MODULE_ID>/telegram/webhook" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1003,"message":{"message_id":3,"chat":{"id":123456789},"text":"Hello test"}}'
```
Expect response:
```json
{"status":"delivered","updateId":1003}
```
Check that the outbox delivered the message to Telegram chat `123456789` as a reply to message `3`.

### Step 4: Verify Update Deduplication
Resend the exact same update (`update_id: 1003`):
```bash
curl -s -X POST "http://localhost:3100/api/myrmidon/pool-chat/modules/<MODULE_ID>/telegram/webhook" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1003,"message":{"message_id":3,"chat":{"id":123456789},"text":"Hello test"}}'
```
Expect response:
```json
{"status":"deduplicated","reason":"update_already_processed","updateId":1003}
```
Verify that the pool transport was not called a second time and no additional quota was debited.

### Step 5: Verify Long Answers Splitting
Send a prompt that produces a long response (> 4096 characters):
- Verify outbox contains multiple parts (`parts.length > 1`).
- Verify each delivered part is `<= 4096` characters.
- Verify parts are delivered in sequence.

### Step 6: Verify Token Redaction in Logs
Search application logs for token leakage:
```bash
# Verify no bot token or secret leaked into logs
grep -E "api.telegram.org/bot[0-9]" /var/log/myrmidon/*.log
```
The search must return **zero** results. Tokens must be replaced with `<redacted>`.

---

## 4. Emergency Disabling

If an incident occurs or a bot token is compromised:
1. Immediately toggle the bridge **Off** in **ChannelSettingsPanel**.
2. Or set environment variable `MYRMIDON_TELEGRAM_POOL_CHATGPT_ENABLED=0` (or `MYRMIDON_TELEGRAM_POOL_GEMINI_ENABLED=0`).
3. Rotate the bot token in BotFather and update the secret storage.
