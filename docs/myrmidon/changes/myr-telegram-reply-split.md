## changelog-en

### Bot replies are no longer cut at 2000 characters (TG-REPLY-FULL)

- The Hermes adapters (local and gateway) used to copy only the first 2,000
  characters of the answer into the run summary, which the chat bridge delivers to
  the owner when the run has no separate final message. Long answers therefore
  arrived in Telegram cut off. The summary now carries the whole answer; the
  existing Telegram publication path then splits anything above the 4,096 limit into
  ordered messages at paragraph, line, then word boundaries (and sends long
  structured Markdown as one attached document). Nothing is silently dropped.
