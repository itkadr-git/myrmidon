export const type = "omp_local";
export const label = "OMP";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @oh-my-pi/pi-coding-agent@18.9.2";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# omp_local agent configuration

Adapter: omp_local

Use when:
- You want Paperclip to run OMP (the AI coding agent) locally as the agent runtime
- You want provider/model routing in OMP format (--provider <name> --model <id> or --model <provider>/<id>)
- You want OMP session resume across heartbeats via --session
- You need OMP's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OMP CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): OMP model id in provider/model format (for example xai/grok-4)
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "omp"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OMP supports multiple providers and models. Use \`omp models ls\` to list available options.
- Paperclip requires an explicit \`model\` value for \`omp_local\` agents.
- Sessions are stored in an isolated company/agent directory and resumed with --session.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to OMP's system prompt via --append-system-prompt, while the user task is sent via -p.
`;
