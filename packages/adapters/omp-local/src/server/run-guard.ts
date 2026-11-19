import fs from "node:fs/promises";
import path from "node:path";
import type { RunGuard, RunGuardDecision, RunGuardStopReason } from "@myrmidon/adapter-utils";

// myrmidon(OMP-RUN-GUARD): the run guard for omp runs.
//
// The guard (model call limit, wrap-up hint before it, read-only exploration and
// repeated-call stops) was fed by the hermes gateway adapter only. An omp run had
// one limit, `timeoutSec` (3 hours on the engineers): on 13.11 the omp sessions
// of seven engineers reached 494 model calls, and the calls past the 150th were
// 27% of all omp calls and 286M input tokens of that day.
//
// omp reports its work as JSON lines on stdout (`--mode json`). This module
// reads the two events the guard needs:
//   - `turn_start`: omp is about to make one model request, which is one model
//     call for the guard;
//   - `tool_execution_start`: one tool call with its arguments, which the guard
//     classifies (read-only or not) and counts.
// The guard decides; the adapter stops the process and delivers the hints
// (execute.ts).
//
// A hint has to reach a session that is already running. `omp -p` reads its
// prompt from stdin once, so the adapter loads a small omp extension with the
// run: the adapter writes the message into the steer file, the extension hands
// the file's text to the session as a user message at the next step boundary
// (`deliverAs: "aside"`: the tool batch in flight is not interrupted) and
// removes the file. Checked against omp 18.9.2 with a stub provider: the
// message is in the context of the next model request.

/** Environment variable the steer extension reads the steer file path from. */
export const OMP_STEER_FILE_ENV = "MYRMIDON_OMP_STEER_FILE";
/** File name of the steer extension inside a directory the board owns. */
export const OMP_STEER_EXTENSION_FILE = "myrmidon-steer.js";
/** Directory (inside the agent's session directory) of the steer files. */
export const OMP_STEER_DIR = ".myrmidon";

/**
 * The steer extension, plain JavaScript for the omp extension loader
 * (`omp --extension <file>`). It must not throw: omp reports a failed extension
 * and goes on without it, and then the hints are not delivered.
 */
export const OMP_STEER_EXTENSION_SOURCE = [
  "// Written by the Myrmidon omp adapter on every run. Do not edit.",
  "// Hands the message the board left in the steer file to the running session.",
  'import fs from "node:fs";',
  "",
  "export default function myrmidonSteer(pi) {",
  `  const file = process.env.${OMP_STEER_FILE_ENV};`,
  "  if (!file) return;",
  "  const deliver = () => {",
  "    let text;",
  "    try {",
  '      text = fs.readFileSync(file, "utf8");',
  "    } catch {",
  "      return;",
  "    }",
  "    try {",
  "      fs.unlinkSync(file);",
  "    } catch {",
  "      // The file cannot be removed: delivering it would repeat on every step.",
  "      return;",
  "    }",
  "    text = text.trim();",
  "    if (!text) return;",
  '    pi.sendUserMessage(text, { deliverAs: "aside" });',
  '    process.stderr.write("[myrmidon] run guard message handed to the session\\n");',
  "  };",
  '  pi.on("tool_execution_end", deliver);',
  '  pi.on("turn_end", deliver);',
  "}",
  "",
].join("\n");

/** Writes the steer extension into `dir` (created when missing) and returns its path. */
export async function writeOmpSteerExtension(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, OMP_STEER_EXTENSION_FILE);
  // Two runs of one agent share the directory: write aside and rename, so a
  // starting omp never loads a half-written file.
  const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(staging, OMP_STEER_EXTENSION_SOURCE, "utf8");
  await fs.rename(staging, target);
  return target;
}

/** A file-name-safe form of the run id for the steer file. */
export function ompSteerFileName(runId: string): string {
  return `steer-${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;
}

// The guard's tool classifier (myrmidon-run-guard-tools.ts) knows the hermes
// tool names. omp's built-in tools do the same things under other names.
// A tool that is not listed keeps its name and counts as a write, which is the
// classifier's safe side: it can only delay a stop.
const OMP_GUARD_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["read", "read_file"],
  ["grep", "search_files"],
  ["bash", "terminal"],
]);

/** The name the run guard's classifier knows an omp tool under. */
export function ompGuardToolName(toolName: string): string {
  return OMP_GUARD_TOOL_NAMES.get(toolName.trim().toLowerCase()) ?? toolName;
}

export type OmpRunGuardHint = NonNullable<RunGuardDecision["hint"]>;

export interface OmpRunGuardFeedOptions {
  guard: RunGuard;
  /** The guard stopped the run on this event. Called once. */
  onStop: (reason: RunGuardStopReason) => Promise<void> | void;
  /** The guard asks to tell the agent something; the run goes on. */
  onHint: (hint: OmpRunGuardHint) => Promise<void> | void;
}

export interface OmpRunGuardFeed {
  /** Feeds one line of omp's stdout to the guard. Never throws on a line it cannot read. */
  observeLine(line: string): Promise<void>;
}

/**
 * Feeds the run guard from omp's JSON event stream. As in the hermes adapter,
 * the wrap-up hint is passed on once, and of the other hints only the first.
 */
export function createOmpRunGuardFeed(options: OmpRunGuardFeedOptions): OmpRunGuardFeed {
  const { guard } = options;
  let wrapUpHintSent = false;
  let hintSent = false;

  const apply = async (alreadyStopped: boolean, decision: RunGuardDecision, toolName: string | null) => {
    if (decision.stop) {
      // A stopped guard keeps answering stop; report the stop on the event that made it.
      if (!alreadyStopped && decision.reason) await options.onStop(decision.reason);
      return;
    }
    const hint = decision.hint;
    if (!hint) return;
    if (typeof hint.remaining === "number") {
      if (wrapUpHintSent) return;
      wrapUpHintSent = true;
    } else {
      if (hintSent) return;
      hintSent = true;
    }
    // The agent knows the tool under omp's name, not under the classifier's.
    await options.onHint(toolName && hint.tool ? { ...hint, tool: toolName } : hint);
  };

  return {
    async observeLine(rawLine: string): Promise<void> {
      const line = rawLine.trim();
      // Most lines are streaming deltas; only the two event kinds are parsed.
      if (!line.startsWith("{")) return;
      if (!line.includes('"turn_start"') && !line.includes('"tool_execution_start"')) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const record = event as Record<string, unknown>;
      if (record.type === "turn_start") {
        const alreadyStopped = guard.stopped;
        await apply(alreadyStopped, guard.modelCall(), null);
        return;
      }
      if (record.type === "tool_execution_start") {
        const toolName = typeof record.toolName === "string" ? record.toolName.trim() : "";
        if (!toolName) return;
        const alreadyStopped = guard.stopped;
        await apply(alreadyStopped, guard.toolStarted(ompGuardToolName(toolName), record.args), toolName);
      }
    },
  };
}
