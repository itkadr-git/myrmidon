---
---

## changelog-en

### Attention cards for the bot-disk lifecycle (1.6.5 BOT-DISK-H4c)

- New cards on the attention queue, computed from the bots' disk reports:
  `agent-silent` (a running bot container whose last report is older than
  30 minutes), `drift` (the copy of a closed task is alive longer than the
  grace plus 15 minutes, with the reason from the report), `foreign` (a copy
  outside the managed layout, raised at once with path and sign).
- `bot_disk_archive` sits on the task while its archive of unpushed work can be
  restored and disappears on restore or after 30 days; `bot_image_stale` is raised
  for a bot whose image generation has not been current for over 24 hours.
- Card wording never carries remote URLs, tokens or e-mail addresses from a report.
