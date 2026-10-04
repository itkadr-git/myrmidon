# Instance → Features: what runs, and does it work (FEATURES)

> Russian version: [features-page.ru.md](features-page.ru.md)

Every fork feature has a setting and a place in the interface, and the operator
must see whether the feature actually works. Before this page several features
silently did nothing for days: the swarm self-claim never claimed, the bot disk
sweep failed with `ENOENT` on every pass, the agent memory tab stayed off, the
shared package cache was refused by a socket filter the deploy had not updated.
Each one was visible only to someone reading logs.

**Instance → Features** (`/company/settings/instance/features`) lists the
features of the fork registry, newest problems first. For each one it shows:

- the **status** — `working`, `off`, `misconfigured`, `failing` or `unknown`;
- why, in one sentence, and the **last successful run**;
- the **errors in the last 24 hours** and the **last error**;
- one **effect metric** ("issues claimed in 24 h", "directories reaped in 24 h",
  "runs held in the queue now");
- the **effective configuration**: every value, where it came from (settings,
  the server environment, the default or derived) and the environment variable
  that can force it;
- a link to the **settings panel** (or an inline **switch** for a simple on/off
  feature) and to the guide.

The page is board-readable. Flipping an inline switch is instance-admin only and
goes through the same service as the feature's own settings (so it is journalled
the same way). A value forced by an environment variable shows the switch locked.

## The statuses

| Status | Meaning |
|---|---|
| `working` | Enabled, and the module shows evidence: a recent successful pass, or an effect in the last 24 hours. |
| `off` | Switched off, or nothing it could act on exists (for example the bot disk lifecycle while bot containers are off). |
| `misconfigured` | Enabled, but the configuration cannot work: a volume root that does not exist, a floor that cannot read the host memory, one of a pair of variables missing, a stopping budget mode with no limit to act on. |
| `failing` | Enabled and configured, but the last pass failed or the feature stands idle next to work it should do. |
| `unknown` | The module has **no health signal** (or none yet). The page says so — `unknown — no health signal` — and never shows `working` it cannot prove. |

## Attention signal

A feature that is enabled and `misconfigured` or `failing` for **more than 30
minutes** raises one card on the operator desk (the attention queue), with the
reason and a link to this page. The card goes away as soon as the feature is
healthy, off or unknown again. The clock is per server process: a restart starts
it again, so a card appears at the earliest 30 minutes after a restart. The
health pass runs every five minutes (`MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC`,
see [SETTINGS.md](../SETTINGS.md)); the first pass waits one minute after start
so the module sweeps have run once.

## Where the health comes from

| Feature | Health signal |
|---|---|
| Swarm self-claim and idle wake | Claim lines in the activity log (24 h), the sweeper's own passes, the last pass's view of the queues (free agents next to ready work). |
| Run admission | The live admission gate (host memory floor open, closed or unreadable) and the queued runs. |
| Bot disk lifecycle | The sweep's own report on every maintenance tick (volume root unreadable, directories reaped). |
| Shared package cache | The bot container reconciler: a refused bind mount, or a bot recreated with the binds. |
| Agent memory card | Every call the card makes to the memory service. |
| Cost attribution sweep | The collection pass, the collected spend rows, runs still unpriced after an hour. |
| Telegram DM status and progress | Delivery rows of the status message (delivered, failed, last error). |
| Chat hold rules | The activity line a lifted hold writes. No line cannot tell "nothing to lift" from "does not work", so it is `unknown`. |
| Budget enforcement | The mode against the active budget policies; incidents of the day. |
| Plugin entitlements | The stored keys: an expired key locks its plugin again. |
| Host disk signal | The sweep's last result (usage, unreadable data root). |
| Workspace quotas | The sweep's last result (measured, failed, over quota). |
| Model fallback signal | The sweep's own pass; a pass that saw no attributed call is `unknown`. |
| Bot language servers | **None at runtime** — `unknown`. The board writes the profile block and cannot see the servers start inside the container; the page shows how many bots are configured with one. |

In-process signals (the sweep reports) are lost on a restart; the page then says
"no pass since the server started" until the next pass. Durable signals (the
activity log, the run and publication tables) survive a restart.

## Adding a feature to the registry

1. Write a `FeatureDefinition` under `server/src/myrmidon/features/definitions/`:
   `readConfig` (effective values with their source, the inline toggle if the
   feature is a plain on/off, and `problems` when the configuration cannot work)
   and `health` (status, reason, last success, error count with the last error,
   one effect metric). Read through `ctx.ports` or `ctx.outcomes(key)` — never
   fake `working`.
2. If the module runs on a timer, report each pass with `recordFeatureOutcome`
   (see `features/recorder.ts`): `ok`, the `error` text (redacted and truncated
   for you), the `effect` and any `detail` the health step reads back.
3. Add the definition to `features/registry.ts` and the name and description
   to `ui/src/i18n/myrmidon-locales/{en,ru}.json` under `features.items.<key>`.

The registry test checks that keys are unique, the guide path exists and every
feature evaluates on an empty instance.
