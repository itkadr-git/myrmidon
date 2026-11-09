<!-- Relocated verbatim from SKILL.md (OPE-11947). Paths are relative to the skill root; "Step N" and "below" keep their original meaning: Steps 1-7 and 9 are in heartbeat-procedure.md, Step 8 in disposition-and-monitors.md, Comment Style in comments-and-planning.md. -->

## Authentication

Env vars auto-injected: `MYRMIDON_AGENT_ID`, `MYRMIDON_COMPANY_ID`, `MYRMIDON_API_URL`, `MYRMIDON_RUN_ID`. Optional wake-context vars may also be present: `MYRMIDON_TASK_ID` (issue/task that triggered this wake), `MYRMIDON_WAKE_REASON` (why this run was triggered), `MYRMIDON_WAKE_COMMENT_ID` (specific comment that triggered this wake, or legacy `PAPERCLIP_WAKE_COMMENT_ID`), `MYRMIDON_APPROVAL_ID`, `MYRMIDON_APPROVAL_STATUS`, and `MYRMIDON_LINKED_ISSUE_IDS` (comma-separated, or legacy `PAPERCLIP_LINKED_ISSUE_IDS`). For local adapters, `MYRMIDON_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `MYRMIDON_API_URL` and `MYRMIDON_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `MYRMIDON_API_KEY` in adapter config. All requests use `Authorization: Bearer $MYRMIDON_API_KEY`. All endpoints are under `/api`. Use JSON except for multipart attachment uploads and binary content downloads. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Adapters deliver the wake payload in the run prompt. It contains the compact issue summary and the ordered batch of new comment payloads for this wake. Read that prompt section first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Myrmidon skills for Claude/Codex and print/export the required `MYRMIDON_*` (and legacy `PAPERCLIP_*`) environment variables for that agent identity.

**CLI safety — use `npx paperclipai` for content-bearing arguments.** When you run the Myrmidon CLI, use `npx paperclipai` for any argument that can hold untrusted content. Untrusted content includes issue text, comment bodies, Markdown, pasted snippets, and model output. `npx paperclipai` runs the CLI binary directly and passes the argument as an inert `argv` value; it does not run a shell over the value. Do not use `pnpm paperclipai` for such an argument. `pnpm paperclipai` is a `package.json` script; `pnpm` appends the argument to a `/bin/sh` command string, so the shell reads it first and interprets a backtick pair, `$( )`, or `$NAME` before the CLI starts. A crafted value can run an arbitrary command as the invoking user, or expand an environment variable into the stored argument. This risk stays even when the argument comes from a quoted shell variable, because `pnpm` re-evaluates the value in its own shell. Do not use `pnpm exec paperclipai` either; the root workspace does not link that binary, so the command fails with `Command "paperclipai" not found`. To run local `cli/src` changes with a content-bearing argument, use `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`. See `doc/CLI.md` for the full safe/unsafe matrix.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $MYRMIDON_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

**Python callers:**

From Python `execute_code`, read the bearer value directly from the environment; do not build a shell/curl command:

If `MYRMIDON_API_KEY` is empty or missing in `execute_code`, do not send the request without it and do not read `/data/hermes/.env` (that copies the secret into the session history): use the terminal (curl with `$MYRMIDON_API_KEY` in double quotes) instead. A 401 is not a transient error — do not retry it. `PAPERCLIP_API_KEY` / `PAPERCLIP_API_URL` are the deprecated aliases of the same two values; read the `MYRMIDON_*` names, and fall back to the alias only if the `MYRMIDON_*` one is missing.

```python
import os
import requests

key = os.environ.get("MYRMIDON_API_KEY") or os.environ["PAPERCLIP_API_KEY"]
url = os.environ.get("MYRMIDON_API_URL") or os.environ["PAPERCLIP_API_URL"]
headers = {"Authorization": f"Bearer {key}"}
response = requests.get(f"{url}/api/health", headers=headers)
```

For `401 did not verify` or `agent_token_unexpanded_variable`, first verify that the bearer token was expanded from the environment; do not assume the board is broken. A literal `$MYRMIDON_API_KEY` usually means shell quoting prevented expansion.
