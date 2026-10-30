---
name: model-instruction-profiles
description: Specialized model instruction profiles (/GLM/GPT/Claude/fallback) and trajectory discipline for Hermes agents.
---

# Model Instruction Profiles and Trajectory Discipline

Use this skill to inspect, configure, and enforce model-specific operational directives across LLM families (/GLM/GPT/Claude with common fallback) and adhere to trajectory stop conditions.

## Model Profiles Overview

1. **GLM Family (`glm-4`, `glm-5`, Zhipu AI / DashScope)**:
   - Enforce strict JSON tool argument syntax without unescaped newlines or embedded code fences.
   - Immediate tool execution without preparatory narrative essays.
   - On tool error, parse the exact error message and modify arguments; do not retry identical calls.
   - Bilingual Russian/English task execution while strictly retaining technical syntax.

2. **GPT Family (`gpt-4o`, `gpt-5`, `o1`, `o3`, OpenAI / Copilot)**:
   - Action over planning: transition to tool action in ≤2 sentences.
   - Concise payloads: avoid echoing large file bodies or massive diff context.
   - Fast exit code verification: check shell and tool results immediately.

3. **Claude Family (`claude-3-5-sonnet`, `claude-3-7-sonnet`, Anthropic)**:
   - Context anchoring: provide 5-8 lines of unique context for patch operations; fallback to full write when fuzzy match fails.
   - Scratchpad discipline: clearly separate internal thought traces from ticket updates and user comments.
   - Rigorous self-verification: run verification commands and inspect actual outputs before completing.

4. **Common Fallback**:
   - Absolute file paths everywhere.
   - Verify before edit (read before write).
   - Non-interactive CLI invocation (`-y`, `--yes`).
   - Stop rule: stop after repeated failures, report blocker rather than looping.

## Trajectory Events & Stop Conditions

Hermes agent runs track trajectory events following Harbor ATIF standards:
- `trajectory.run_start`: Model, family, provider, and prompt fingerprint.
- `trajectory.step`: Reasoning step index and timing.
- `trajectory.tool_call`: Tool invocation with argument hash and repeat check.
- `trajectory.tool_result`: Output status, duration, error classification, and consecutive error counter.
- `trajectory.stop_condition`: Triggered when a tool fails 3 times consecutively (`consecutive_errors >= 3`) or repeats identical failed calls.
- `trajectory.run_complete`: Run summary, total tool calls, error metrics, and produced artifacts.

## Best Practices for Agents

- If a patch fails twice: STOP patching. Read the file completely and use `write_file`.
- If a terminal command returns non-zero: STOP. Read stderr, fix the command or missing dependency.
- If a dependency is missing: Report a blocker or install if permitted; do not repeat failing imports.
- Never exit without an artifact (commit, PR, or explicit blocker).
