## Guides

Deep-dive guides from [`docs/myrmidon/guides`](https://github.com/itkadr-git/myrmidon/tree/main/docs/myrmidon/guides) in the repository, grouped by product area. Each guide is available directly in this wiki as a standalone page.

### Agents and castes

- [Agent actors with permission grants: environments and tool connections](Actor-grant-routes)

- [Board administrator: the agent-card toggle and the rights page](Agent-board-admin)

- [Agent memory: the agent card's Memory tab](Agent-memory-card)

- [Agent instructions: revision history and restore](Agent-instructions-revisions)

- [Discussion rooms on issue cards (1.7 AGENT-EXCHANGE-A)](Agent-exchange)

- [Agent exchanges: the owner's feed of the discussion rooms](Agent-exchange-feed)

- [Custom castes — the company agent-role directory](Custom-castes)

- [Asymmetric debates: generator, critic, and a judge outside the dispute (1.7 DEBATE-ASYM A)](Debate-asym)

- [Debates per caste and the «Discuss» button on a caste's task (1.7 DEBATE-ASYM B)](Debate-asym-castes)

- [Swarm (self-organisation) settings](Swarm-claim-settings)

- [Self-organization: castes, nests, pheromones](Swarm-self-organization)

- [Parallel helpers](Parallel-helpers)

- [Agent and execution architecture pages](Agent-execution-architecture)

- [Agents Fleet in UI-2](Ui2-agents-fleet)



### Tasks and the board

- [Agent defaults for the issue list (1.6.5 F-16, part A)](Issue-list-agent-defaults)

- [A task settles once its pull requests merge (TASK-PR-SYNC)](Task-pr-sync)

- [WIP limit: the per-agent work-in-progress cap](Wip-limit)

- [The Commander chat screen: free-text planning in the portal (CTO-CHAT A)](Commander-chat)

- [The board chat planner: owner text to a proposed epic (CTO-CHAT B)](Cto-chat-planner)



### Telegram and channels

- [Telegram fields on the agent card](Agent-telegram-card)

- [Channel allowlist — who may write to the bots](Channel-allowlist)

- [Chat endpoint setup and verification](Chat-endpoint-setup)

- [Agent question and confirmation cards delivered to the owner's Telegram](Owner-telegram-cards)

- [Owner active channel: reports follow the owner between portal and Telegram (1.7-ACTIVE-CHANNEL)](Owner-active-channel)

- [Telegram Commands for Plan Acceptance/Rejection](Telegram-accept-reject)

- [Telegram bridged chat: addressing any company agent with @<alias>](Telegram-alias-addressing)

- [Telegram bridge: service texts follow your language (TG-LOCALE)](Telegram-bridge-locale)

- [Telegram DM: editable run status and inline split of long answers](Telegram-dm-status)

- [Addressing agents from one Telegram chat](Telegram-multi-agent)

- [Telegram group topics as a task inbox (topic inbound)](Telegram-topic-inbound)

- [Interaction webhook and event deduplication](Interaction-webhook-dedupe)

- [CTO-CHAT: the `/plan` command in Telegram](Cto-chat-telegram-plan)

- [Interactive readdress dry-run](Readdress-report)

- [Owner update notifications (TG-NOTIFY)](Owner-update-notifications)



### Models, keys and tracing

- [Company model providers (registry, write-only keys, model cache)](Model-providers)

- [LLM tracing: how the pipeline works, where the data lives, how to verify it (TRACING-HEALTH)](Tracing)

- [LLM tracing health: the status card and the operator signal (TRACING-HEALTH)](Tracing-health)



### Knowledge, learning and quality

- [Foraging: knowledge gathering from approved sources (1.6 FORAGING)](Foraging)

- [Knowledge (KNOWLEDGE-2.0, 1.6.6)](Knowledge)

- [Importing the corpus from RAGFlow](Corpus-ragflow-import)

- [Corpus MCP tools for board bots](Corpus-mcp-tools)

- [Knowledge-on-change metrics (KNOWLEDGE-ON-CHANGE, 1.6.6)](Knowledge-on-change-metrics)

- [Company regulations in the wiki (draft → approved, revisions, rollback)](Wiki-regulations)

- [Foraging idle gate (myrmidon 1.6.3 FORAGING-IDLE-GATE)](Foraging-idle-gate)

- [ADM knowledge migration guide (OPE-9263)](Adm-knowledge-migration)

- [Reference-task evals: the LLM judge and the threshold+repeat verdict (1.6 EVALS-A)](Reference-task-evals)

- [Evals: Cross-Family Judge Selection](Evals-judge-family-selection)

- [Baseline comparison on the Quality screen](Baseline-comparison)

- [Baseline snapshots API](Baseline-snapshots-api)



### Autonomy and guardrails

- [Autonomy matrix: execution points](Autonomy-matrix)

- [AUTONOMY-MATRIX: Holding Actions for Approval](Autonomy-matrix-holding-actions)

- [Autonomy Matrix: Instructions Change Control](Autonomy-matrix-instructions)

- [Autonomy matrix in the tool gateway](Autonomy-matrix-tool-gateway)

- [Autonomy Matrix DELETE Action Enforcement](Autonomy-delete-enforcement)

- [Autonomy matrix: the deploy action class](Autonomy-deploy-merge)

- [Autonomy Matrix — Pause, Resume, Wake Enforcement](Autonomy-pause-wake-enforcement)

- [Guardrail enforcement modes, settings, and journal UI](Guardrails-modes-settings)

- [Guardrail run-output limits and redaction](Guardrails-run-output)

- [GUARDRAILS false-positive eval on the reference corpus (CI check)](Guardrails-ci-corpus)

- [Redaction modes](Redaction-modes)

- [Emergency stop for drained-pause runs](Emergency-stop)

- [Automatic resume of an agent left in `error` (AUTO-RESUME)](Auto-resume)

- [Run stall detection (progress-based run liveness)](Run-stall)

- [Queued-run stall signal (F-09)](Queued-run-stall)

- [Fix for WAKE-STALL-ROOT B Issue](Fix-wake-stall-root-b)

- [Wake Resurrection Service](Wake-resurrection-service)

- [Stale-block watchdog (dead blocked reasons)](Stale-block)

- [The long-task context guard (1.6.6 LONG-TASK-CONTEXT)](Long-task-context)

- [Run admission limits](Run-limits)

- [Instance execution policy and attention feed settings (1.6.6 SETTINGS-UI S)](Instance-execution-policy-and-attention)

- [Autonomy Matrix DELETE Route Mapping](Delete-route-mapping)



### Budgets and spend limits

- [Budget enforcement: signal, soft pause, or hard refusal (1.7 BUDGET-CONFIG B)](Budget-enforcement)

- [Spend limits per hierarchy level (1.7 BUDGET-CONFIG)](Budget-limits)

- [Spend limits per level: the owner's screen (1.7 BUDGET-CONFIG D)](Budget-limits-ui)

- [LiteLLM budget projection (BUDGET-CONFIG C)](Litellm-budget-projection)

- [LiteLLM key budgets](Litellm-key-budgets)

- [LiteLLM v1.104.1 streaming cost overlay](Litellm-streaming-cost-overlay)

- [Prompt budget advice and deep analysis](Prompt-budget-advice)



### Connectors and tools

- [Access hub](Access-hub)

- [alibaba-image connector: free image generation and editing for agents](Alibaba-image-connector)

- [Google AI connector owner guide](Google-ai-connector)

- [Clouds: cloud storage through the connector](Cloud-connector)

- [Microsoft 365 files and mail for container bots](Cloud-files-connector)

- [External MCP connectors: connect without fork code](External-mcp-connectors)

- [Connector panel: pairing, signing policy and the journal](Connector-panel)

- [Browser bridge: the client connector gateway and pairing](Browser-bridge-gateway)

- [Browser bridge extension (parts C and D)](Bridge-extension)

- [Signing host contract (native messaging)](Signing-host-contract)

- [GitHub Credentials Cache and Fuse Policy (1.6.6 OPE-9997, 1.6.7 OPE-12446)](Github-credentials-cache)

- [Authorize GitHub once for the whole server with our own GitHub App (GITHUB-SHARED-IDENTITY)](Github-shared-identity)

- [Plugin runtime capabilities](Plugin-capabilities)

- [Plugin entitlement keys](Plugin-entitlement-keys)



### Running the server

- [API Load Monitoring and Latency Alerting (1.6.6 OPE-9997)](Api-load-monitoring)

- [Board update policy: maintenance window, mode, fleet canary](Auto-update-window-canary)

- [Capacity policy canary runbook](Capacity-policy-canary)

- [Capacity policy candidate ordering](Capacity-policy-composer)

- [Fleet dashboard data: VictoriaMetrics + Zabbix connections, snapshot API, selfcheck (1.6.6 MONITORING C)](Fleet-dashboard-monitoring)

- [Server console](Server-console)

- [UI2 "Servers" screen (/fleet)](Ui2-servers)

- [The Myrmidon 2.0 shell behind `enableMyrmidonUi2` (UI 2.0)](Ui2-shell)

- [Instance → Features: what runs, and does it work (FEATURES)](Features-page)

- [Instance users](Instance-users)

- [User Administration & Audit Log (users-admin-a)](Users-admin-a)

- [Company Users administration: the owner's screen (1.7 USERS-ADMIN-UI B)](Users-admin-ui)

- [The maintenance banner](Maintenance-banner)

- [Workspace cleanup after merge](Workspace-cleanup)

- [Database backup retention](Backup-retention)

- [Automatic rollback by health after a deploy](Deploy-auto-rollback)

- [Deployment cooldown and HTTP 429 retries (bounded retry and wake suppression)](Deployment-cooldown-retries)

- [Remote Execution Sites: Site-Agent Contract and Operator Guide](Remote-execution-sites)

- [Stand scenario: kill the gateway mid-run](Team-liveness-stand-scenario)

- [Bot container: the agent card's Container section](Bot-container-card)

- [Bot language servers (BOT-LSP)](Bot-lsp)

- [OCR path: PDF to text in the bot workspace](Ocr)

- [Browsers: live screen console](Browsers)

- [Environment variable names: MYRMIDON_* with the PAPERCLIP_* alias](Env-names-alias)

- [Custom Localization Catalog Upload and Validation API](Locale-upload)



### Releases and branding

- [Product name in the docs](Docs-branding)

- [Product branding in the UI (B1a)](Ui-product-branding)

- [Rebrand B: server texts, installer, CLI output, API messages](Rebrand-b-server-texts)

- [The vendor name in the build (REBRAND F)](Rebrand-vendor-name)

- [Rebrand D: board MCP tool names are `myrmidon*`, old names are aliases](Mcp-tool-names)

- [Tab and home-screen icon (FAVICON)](Favicon)

- [Vendor share of the repository](Vendor-share-analysis)

- [Vendor-derived share in the release notes (VENDOR-SHARE-METRIC, 1.6.5)](Vendor-share-release-metric)

- [Brand release check (read-only, before the tag)](Brand-release-check)

- [OPE-9335: onboarding identity and persisted instruction refresh](Onboarding-identity-refresh)

- [Licensing of closed modules](Licensing)

- [Stack registry](Stack-registry)

- [Plugin upgrade capability approvals](Plugin-upgrade-approvals)
