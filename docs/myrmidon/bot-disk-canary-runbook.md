# Bot disk (BOT-DISK-H): canary, integration run and host-script shutdown

Runbook for the last three steps of the BOT-DISK-H mechanism: the integration
check of all parts together, the canary on three development bots, and the
shutdown of the old host-side cleanup scripts. Nothing here is run by CI; the
automated part of the integration check is
`scripts/myrmidon/bot-runtime/bot-disk-integration.test.mjs`. Settings are in
[bot-disk-cache.md](bot-disk-cache.md), [bot-disk-quota.md](bot-disk-quota.md)
and the contract in [bot-disk-contract/](bot-disk-contract/README.md).

Russian version: [bot-disk-canary-runbook.ru.md](bot-disk-canary-runbook.ru.md).

## 1. What the automated test covers, and what only a stand can

| Design scenario | Automated (`bot-disk-integration.test.mjs`, real git, local origin, fake board) | Stand / canary only |
|---|---|---|
| Task done: the copy goes within grace + one pass | yes: no removal inside the grace, removal after it, the active neighbour untouched, the C4 report validates | the real 15 minutes on a live board |
| Unpushed work is archived first | yes: bundle and untracked tar exist before the copy is gone; a failing archive keeps the copy and the registry entry | none |
| `myr-ws restore` returns branch and commit | yes (branch tip and file content) | the diff on a real task |
| Board down: nothing is deleted | yes (`desired` not ok: zero actions, a `skip` row in the report) | a real 503/timeout from the board |
| Drift: copy deleted by hand | yes: stale worktree record pruned, base stays | the attention card on the board |
| Orphan copy waits the orphan grace | yes | none |
| Image has `myr-ws`, `botd`, the git wrapper; 15 clone forms | no (Dockerfile gate and wrapper tests cover the files) | `git --version` through the wrapper, clone forms, no token in `.git/config` |
| Run with `workspace` in `/v1/runs` | no | a real run on a canary bot |
| Quota (`prjquota`): ENOSPC only for the bot at the limit | no | needs the quota-enabled partition |
| pnpm: reflink self-check, physical weight of a copy <= 350 MB | no | needs the shared store on the partition |

Finding while writing the test: `myr-ws close` drops the registry entry, and
`myr-ws restore <KEY>` reads the repository from that entry. After botd has
closed a copy, the restore therefore needs the entry first (re-open the copy
with `myr-ws open <KEY> owner/repo`, which writes it). The test follows this
order. The behaviour is documented here, not changed.

## 2. Canary on three development bots

Order (from the epic): the image with `myr-ws`, `botd` and the wrapper goes to
the three canary bots first; the partition quota step and the other waves
follow only after the measurements below pass.

1. Pre-flight, on the board host, facts into the task comment:
   - free space on the bots partition and on the root filesystem (a root above
     90 % blocks the board database writes: stop and fix that first);
   - `GET /api/myrmidon/bot-disk` shows `enabled: true` and the intended
     settings; the three canary bots run the target image generation.
2. Per canary bot, `botd --once --plan` (dry run, nothing executed, nothing
   sent) and read the plan: only closed or orphan copies may appear. A plan
   that names an active task copy is a stop.
3. Let the loop run. Measurements at 24 hours (the first checkpoint) and again
   at the end of the window:
   - foreign directories, promisor packs, `.git/config` files with userinfo:
     all zero for the window (botd report and `myr-ws list`);
   - copies of terminal tasks removed within grace + 15 minutes: at least 95 %;
   - the physical weight of a new task copy after `pnpm install`: at most 350 MB
     (`du` of the copy, store excluded);
   - the reflink self-check reports ok.
4. After the partition is mounted with project quotas: the ENOSPC test on one
   canary bot only (`PUT .../quota` through the board, fill the bot to its
   limit): the bot gets ENOSPC, `myr-ws open` answers
   `BOT_DISK_QUOTA_EXCEEDED:`, the neighbours still write. Return the quota to
   its normal value afterwards.
5. Report the numbers (not "ok") in the task, then the waves on the rest of
   the fleet.

Stop switch for the whole mechanism: `PATCH /api/myrmidon/bot-disk` with
`{"enabled": false}`. The desired-state route then answers 503 and botd treats
it as "no desired state", which removes nothing (this is the fail-safe case of
the integration test). Switching back on is the same call with `true`.

## 3. Shutdown of the host-side cleanup scripts (phase 5)

The old cleanup (a systemd timer running `duperemove`, and the ad-hoc
`prune-*` scripts) is switched off only when the replacement is proven on the
live fleet. This is a production step for the infrastructure owner, not for CI.

Preconditions, each with the command output attached:

1. The partition is mounted with project quotas (`findmnt` options contain
   `prjquota`) and the quota report is not empty.
2. botd is alive on the fleet: fresh disk reports, no open drift or foreign
   cards.
3. Used space of the bots partition is at most 60 %. Above that, do not
   switch off; escalate with the numbers (growth without the scripts was
   measured at several GiB per hour).
4. No agent run is in progress on the host (use the normal restart window).

Steps:

1. Back up the unit files and the crontabs into a dated file
   (`systemctl cat <dedupe service> <dedupe timer>`, `crontab -l` of every
   user, `ls /etc/cron.d`).
2. `systemctl disable --now <dedupe timer>`; check `is-enabled` = disabled,
   `is-active` = inactive and that `list-timers` no longer shows it.
3. Do not delete the scripts: rename each to `<name>.disabled-F5-<date>`.
   Check: the number of disabled files equals the number of scripts, and no
   executable `prune-*` or migration script is left under its old name.
4. Announce on the infrastructure thread that manual prune runs on the bots
   partition stop from this date (criterion 6 counts them).
5. Record the used space of the partition every 10 minutes for 24 hours,
   attach the series.

Rollback before the deletion: `systemctl enable --now <dedupe timer>` and
rename the files back. The scripts only free space, so a rollback loses no data.

Deletion after 14 days is a separate dated check: only if for 14 days the
daily change of the partition stayed within 5 GiB, used space stayed within
60 % and there was no manual `rm`/prune on it, remove the disabled scripts,
the unit files (`daemon-reload` afterwards), the hash file and the log, after
confirming that the unit backup exists. If the metrics are not stable, do not
delete; report the numbers to the owner.
