# OPE-12716: DEPLOY-SMOKE-REMOTE and DEPLOY-SMOKE-OOM-WARN (rc.23 follow-up)

## Summary

Post-deploy bot smoke (`scripts/myrmidon/deploy/bot-apply-smoke.sh`) improvements following the 11.11 rc.23 incident:

1. **DEPLOY-SMOKE-REMOTE**: Bots pinned to another host (`adapterConfig.container.host != "local"`, e.g. the 12 `work-*` bots on `myr-vm1`) have no container on the deploy host. Local Docker only knows "No such container" for them. The smoke now detects remote-host bots via `GET /companies/:id/agent-configurations`, queries their gateway health directly over their `apiBaseUrl` (`/health`), and falls back to board status without touching local Docker. Gateway diagnosis names the bot host (`remote host <host>: логи на хосте`) instead of emitting "No such container" noise.
2. **DEPLOY-SMOKE-OOM-WARN**: An in-window `OOMKilled` exit (exit 143/137) is treated as a deploy failure only if the container was re-created/restarted by the rollout (or started inside the deploy window) or if multiple bots OOMed across the fleet. A single OOM of a container untouched by the deploy is logged as a `WARNING` with the bot ID and memory limit (exit code 0), preventing deploy rollback when a bot runs its own heavy workload during the window.
3. Added end-to-end integration tests in `scripts/myrmidon/deploy/release-gate.test.mjs` verifying remote gateway health checks and single vs multi-bot OOM classification.
