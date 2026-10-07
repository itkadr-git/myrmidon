## changelog-en

### The board enforces bot disk quotas through dockergate (1.6.5 BOT-DISK-H, part H9c)

- The bot disk quota sweep now puts the quota it resolves (card, per-agent,
  per-caste, default) as the hard xfs project limit of the bot
  (`PUT /myrmidon/disk/<botKey>/quota` of dockergate), once per change: a quota
  already in force or already applied is not sent again, and a refused PUT is
  retried only after the remeasure interval.
- Usage for the 80 % / 100 % `bot_disk_quota` signals and for the clone admission
  check is the physical figure of `GET /myrmidon/disk`. When quotas are not
  enabled on the bot partition, or dockergate does not answer, the previous du
  walk is the estimate and the signal says so (`usageSource: "estimate"`).
- An unreachable or off-contract dockergate never fails a sweep tick.

## changelog-ru

### Доска исполняет квоты диска ботов через dockergate (1.6.5 BOT-DISK-H, часть H9c)

- Проход по квотам диска ботов теперь выставляет разрешённую квоту (карточка,
  по агенту, по касте, по умолчанию) жёстким лимитом xfs-проекта бота
  (`PUT /myrmidon/disk/<botKey>/quota` dockergate) один раз на изменение: уже
  действующая или уже применённая квота не шлётся повторно, отклонённый PUT
  повторяется не раньше интервала перемера.
- Занятое место для сигналов `bot_disk_quota` 80 % / 100 % и для проверки
  перед клоном берётся физическим числом из `GET /myrmidon/disk`. Если квоты на
  разделе ботов не включены или dockergate не отвечает, оценкой служит прежний
  обход du, и сигнал это помечает (`usageSource: "estimate"`).
- Недоступный или не по контракту dockergate не роняет такт прохода.
