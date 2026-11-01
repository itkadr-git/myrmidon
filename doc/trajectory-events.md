# Trajectory Events and Model Instruction Profiles (1.6.6 DEVEFF)

Aligned with issue **OPE-10097** and parent **OPE-9995** (Devtools analysis — Kodik, Harbor ATIF, and agent development tools).

## 1. Overview & Context

Analysis of agent development tools in **OPE-9995** highlighted key failure modes in autonomous coding agents:
1. **Model Family Instruction Mismatch**: Different LLM families (GLM, GPT, Claude) exhibit distinct operational failure modes:
   - **GLM models** (e.g., GLM-4, GLM-5 via DashScope/Zhipu) can produce invalid JSON parameter syntax, repetitive narrative preambles, or hallucinatory tool outputs when instructions do not enforce rigid schema compliance and error recovery rules.
   - **GPT models** (e.g., GPT-4o, GPT-5) tend to produce excessive multi-paragraph planning without transitioning into tool action, or get stuck in non-converging exploratory reads.
   - **Claude models** (e.g., Claude 3.5/3.7 Sonnet) require high-fidelity diff/patch context discipline and clear separation between scratchpad thinking and final communication.
2. **Invisible Tool Errors & Repetition Loops**: Agents often repeat the same failing tool command (e.g., failing patch, invalid shell command, or empty search) multiple times in a single heartbeat, consuming context and tokens without making forward progress.
3. **Lack of Structured Trajectory Observability**: Without a standardized trajectory schema (such as Harbor ATIF — Agent Trajectory Interchange Format), runs cannot be replayed, measured across model families, or audited for stop-condition violations.

This document defines:
- **Model Instruction Profiles** for `/GLM/GPT/Claude` with a common fallback.
- **Trajectory Events Schema** for step-by-step agent execution, tool calls, and run lifecycle.
- **Tool Error & Repeat Stop Rules** with deterministic thresholds to prevent runaway loops.

---

## 2. Model Instruction Profiles Architecture

Instruction profiles are resolved at prompt-generation time in the Hermes adapter (`packages/adapters/hermes/src/server/model-instruction-profiles.ts`) using the model name and provider metadata:

```
                  ┌───────────────────────┐
                  │ Model Name & Provider │
                  └───────────┬───────────┘
                              │
                    detectModelFamily()
                              │
          ┌──────────────┬────┴─────────┬──────────────┐
          ▼              ▼              ▼              ▼
       ┌─────┐        ┌─────┐       ┌────────┐    ┌──────────┐
       │ GLM │        │ GPT │       │ Claude │    │ Fallback │
       └─────┘        └─────┘       └────────┘    └──────────┘
          │              │              │              │
          └──────────────┴────┬─────────┴──────────────┘
                              ▼
                 + Common Fallback Directives
                              ▼
                   Final Injected Prompt
```

### Profile Specifications

### A. Common Fallback Profile (`fallback`)
Applies to all agents as a shared foundation, or when the model family is unclassified:
- **Action over plan**: Always take action using tools; never end a heartbeat with only plans or summaries when actionable tasks remain.
- **Absolute paths**: Always use full absolute paths combining the workspace root and relative paths.
- **Verify before modify**: Read existing file content and surrounding context before patching or overwriting.
- **Non-interactive execution**: Always supply non-interactive CLI flags (`-y`, `--yes`, `--non-interactive`) to prevent hung terminal sessions.
- **Stop condition & Anti-loop**: Never repeat an identical failing tool call. If a tool fails twice, switch strategy (e.g., replace targeted patch with read + full write) or report a clear blocker.
- **Mandatory artifact gate**: Runs must conclude with concrete deliverables (commit, PR, artifact, or explicit blocker).

### B. GLM Profile (`glm`)
Specialized for Zhipu AI / DashScope GLM models (`glm-4`, `glm-5`, `chatglm`):
- **Strict JSON tool arguments**: Tool arguments must be strictly valid JSON without raw unescaped newlines, unbalanced quotes, or pseudo-markdown code blocks inside arguments.
- **Tool error recovery**: On tool failure, inspect the exact error message. Do not re-run the same command or patch without modifying arguments. If a patch fails due to non-unique context, read the file around the target area first.
- **Execution sequencing**: Do not emit narrative summaries of tool intentions prior to calling tools; execute tools first, then report findings.
- **Language discipline**: Support bilingual instructions (Russian/English) while preserving strict code syntax, commit conventions, and English technical identifiers.

### C. GPT Profile (`gpt`)
Specialized for OpenAI / Copilot GPT models (`gpt-4o`, `gpt-5`, `o1`, `o3`):
- **Plan-to-action transition**: Formulate at most a 1-2 sentence orientation before invoking the first tool call; avoid exhaustive narrative multi-step plans that consume the turn budget.
- **Lean tool arguments**: Avoid echoing massive file contents into tool arguments when targeted reads or search patterns suffice.
- **Self-correction**: Check exit codes of shell commands immediately; abort sequences if prerequisite steps fail.

### D. Claude Profile (`claude`)
Specialized for Anthropic Claude models (`claude-3-5-sonnet`, `claude-3-7-sonnet`, `claude-opus`):
- **Patch context uniqueness**: Provide 5-8 lines of unique surrounding context for patch operations. If a patch fails with multiple matches, expand the anchor lines or use full file replacement.
- **Scratchpad distinction**: Keep internal reasoning inside thinking tags or scratchpad lines distinct from operator-visible comments and tickets.
- **Sub-agent discipline**: When delegating to sub-agents, enforce single-responsibility boundaries and strict verification of sub-agent outputs.

---

## 3. Trajectory Events Schema

Trajectory events capture the fine-grained sequence of agent reasoning steps, tool invocations, results, and stop-condition triggers. They can be stored in `heartbeat_run_events` or exported in Harbor ATIF format.

### Schema Definition (JSON Schema Draft-07)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TrajectoryEvent",
  "description": "Standardized event schema for agent trajectories, tool invocations, and stop conditions",
  "type": "object",
  "required": [
    "eventId",
    "eventType",
    "timestamp",
    "runId",
    "agentId",
    "companyId",
    "stepIndex",
    "payload"
  ],
  "properties": {
    "eventId": { "type": "string", "format": "uuid" },
    "eventType": {
      "type": "string",
      "enum": [
        "trajectory.run_start",
        "trajectory.step",
        "trajectory.tool_call",
        "trajectory.tool_result",
        "trajectory.stop_condition",
        "trajectory.run_complete"
      ]
    },
    "timestamp": { "type": "string", "format": "date-time" },
    "runId": { "type": "string" },
    "agentId": { "type": "string" },
    "companyId": { "type": "string" },
    "stepIndex": { "type": "integer", "minimum": 0 },
    "payload": {
      "type": "object",
      "required": ["version"],
      "properties": {
        "version": { "type": "integer", "enum": [1] }
      }
    }
  }
}
```

### Event Types and Payload Shapes

#### 1. `trajectory.run_start`
Fired when the heartbeat execution begins.
- `model`: (string) Model identifier (e.g. `glm-5.3`, `gpt-5.4`).
- `modelFamily`: (string) Detected family (`glm`, `gpt`, `claude`, `fallback`).
- `provider`: (string) Resolved provider (e.g. `dashscope`, `copilot`, `anthropic`).
- `promptSha256`: (string) Hash of initial prompt.

#### 2. `trajectory.step`
Fired at each reasoning turn / cycle.
- `stepIndex`: (number) 0-indexed step counter.
- `reasoningPreview`: (string, optional) Redacted thinking excerpt.
- `tokenUsage`: (object, optional) `{ inputTokens, outputTokens, totalTokens }`.

#### 3. `trajectory.tool_call`
Fired when a tool call is dispatched.
- `callId`: (string) Unique call identifier.
- `toolName`: (string) Name of tool (e.g., `terminal`, `patch`, `read_file`).
- `inputSummary`: (string) Truncated / sanitized argument preview.
- `isRepeat`: (boolean) Whether this tool call is identical to an earlier recent invocation.

#### 4. `trajectory.tool_result`
Fired when a tool completes.
- `callId`: (string) Matching call ID.
- `toolName`: (string) Name of tool.
- `status`: (string) `success` | `error` | `timeout`.
- `durationMs`: (number) Execution duration in milliseconds.
- `error`: (string, optional) Error message or exit code description.
- `consecutiveErrors`: (number) Consecutive error count for this tool.
- `isRepeatFailure`: (boolean) True if this tool failed in the same way consecutively.

#### 5. `trajectory.stop_condition`
Fired when execution is halted by an automated safety guard.
- `condition`: (string) `repeated_tool_error` | `repeated_tool_call` | `consecutive_no_op` | `budget_exceeded`.
- `toolName`: (string, optional) The triggering tool name.
- `consecutiveFailures`: (number, optional) Count of consecutive failures.
- `message`: (string) Human-readable explanation.
- `action`: (string) `abort_run` | `escalate_blocked` | `request_human_input`.

#### 6. `trajectory.run_complete`
Fired when the run terminates.
- `status`: (string) `completed` | `failed` | `aborted`.
- `totalSteps`: (number) Total steps executed.
- `totalToolCalls`: (number) Total tool calls executed.
- `totalErrors`: (number) Total errors encountered.
- `repeatedErrorCount`: (number) Number of repeated errors detected.
- `artifacts`: (array of strings) Created artifacts (e.g., PR URL, commit SHA, document key).

---

## 4. Tool Error and Repeat Stop Rules

To eliminate idle token burning and loop traps:
1. **Consecutive Error Limit**:
   - If the same tool fails `3` times consecutively (`consecutiveToolErrors.count >= 3`), the run is immediately aborted with status `failed` and stop condition `repeated_tool_error`.
   - A successful tool invocation resets `consecutiveToolErrors` to `null`.
2. **Identical Invocation Repeat Limit**:
   - If a tool is called with identical arguments within a 3-step window and fails, it is flagged as `repeated_tool_error` on the second occurrence and aborted if not corrected.
3. **Escalation**:
   - Runs aborted via stop rules emit `trajectory.stop_condition` run-log events and update the issue with actionable error telemetry.
