// STAND SCENARIO (TEAM-LIVENESS, 1.6.5): kill the gateway mid-run and watch the
// board bring the team back by itself.
//
// Why this file exists: the operator watchdog (`team-watch.sh`) is switched off
// only after the board has been seen recovering a killed gateway on its own,
// inside the ticket's 10-minute budget. This runner is that rehearsal. It does
// not carry its own opinion about liveness: every decision is taken by the
// product passes (RUN-STALL by progress, AUTO-RESUME, IDLE-PICKUP) built exactly
// as `server/src/index.ts` and `services/heartbeat.ts` build them. The runner
// only seeds the situation, kills the process, moves the clock and reads the
// database back.
//
// Two modes:
//
//   rehearse  Self-contained and deterministic. Starts a throwaway embedded
//             Postgres (the same one the test suite uses), seeds a company with
//             one agent whose run was progressing and whose gateway process is
//             real, SIGKILLs that process, then drives the three product passes
//             over a simulated clock in 5-second steps for the whole budget.
//             The knobs go through the instance settings API first, so the run
//             also shows a saved value taking effect without a restart.
//
//   watch     Read-only, against the live board database (`DATABASE_URL` or the
//             embedded port of a local board). The operator kills the real
//             gateway and runs this: it follows the killed run, its task and the
//             agent from the database and prints the same verdict, or says which
//             leg never arrived.
//
// Usage:
//   tsx scripts/myrmidon/team-liveness/stand-recovery.ts rehearse [--budget-min 10]
//       [--stall-sec 120] [--json] [--db <url>] [--then-watch]
//   tsx scripts/myrmidon/team-liveness/stand-recovery.ts watch --since <iso>
//       [--agent <name|id>] [--budget-min 10] [--json]
//
// The verdict is the deliverable, so the exit code carries it: 0 for PASS, 1
// for FAIL.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  closeRegisteredClients,
  createDb,
  loadWithoutEmbeddedPostgresExitHooks,
  startEmbeddedPostgresTestDatabase,
} from "../../../packages/db/src/index.js";
import { loadConfig } from "../../../server/src/config.js";
import { createRunStallSweepFromHeartbeat } from "../../../server/src/myrmidon/run-stall/index.js";
import { teamLivenessService } from "../../../server/src/myrmidon/team-liveness/service.js";
import { heartbeatService } from "../../../server/src/services/heartbeat.js";
import { issueService } from "../../../server/src/services/issues.js";

type Db = ReturnType<typeof createDb>;
type Row = Record<string, unknown>;
/** The postgres.js tagged template behind the drizzle instance. */
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

function sqlOf(db: Db): Sql {
  return (db as unknown as { $client: Sql }).$client;
}

type Milestone = { atMs: number; line: string };

/**
 * A dead or unreachable database has to fail the scenario, not hang it: the
 * operator is watching a stand, not a log file. postgres.js queues a query
 * against a server that stopped answering instead of rejecting it, so every
 * step that must answer is bounded here.
 */
async function withTimeout<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Verdict {
  mode: "rehearse" | "watch";
  recoveredMs: number | null;
  budgetMs: number;
  legs: { runSettled: boolean; taskNotWaiting: boolean; agentNotStuck: boolean };
  milestones: Milestone[];
  evidence: Record<string, unknown>;
}

function parseFlags() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "budget-min": { type: "string" },
      "stall-sec": { type: "string" },
      "then-watch": { type: "boolean" },
      db: { type: "string" },
      since: { type: "string" },
      agent: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const mode = positionals[0];
  if (mode !== "rehearse" && mode !== "watch") {
    console.error("Usage: stand-recovery.ts <rehearse|watch> [--budget-min 10] [--json]");
    process.exit(2);
  }
  return {
    mode: mode as "rehearse" | "watch",
    budgetMs: Math.max(1, Number(values["budget-min"] ?? "10")) * 60_000,
    stallSec: values["stall-sec"] ? Number(values["stall-sec"]) : null,
    thenWatch: values["then-watch"] === true,
    db: values.db ?? null,
    since: values.since ? new Date(values.since) : null,
    agent: values.agent ?? null,
    json: values.json === true,
  };
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * The exit code the verdict asks for. It is applied twice on purpose: once when
 * the verdict is printed, and once at the end of `main`, because tearing the
 * embedded Postgres down owns the process's exit path and would otherwise drop
 * a FAIL's code.
 */
let verdictExitCode: number | null = null;

function printVerdict(verdict: Verdict, json: boolean, setExitCode = true) {
  if (json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    for (const milestone of verdict.milestones) {
      console.log(`  t+${minutes(milestone.atMs).padStart(7)}  ${milestone.line}`);
    }
    console.log("");
  }
  const legsPassed =
    verdict.legs.runSettled && verdict.legs.taskNotWaiting && verdict.legs.agentNotStuck;
  const withinBudget = verdict.recoveredMs !== null && verdict.recoveredMs <= verdict.budgetMs;
  console.log(
    `${legsPassed && withinBudget ? "PASS" : "FAIL"}: ${
      verdict.recoveredMs === null
        ? "the team never came back on its own"
        : `the team came back in ${minutes(verdict.recoveredMs)}`
    } (budget ${minutes(verdict.budgetMs)})`,
  );
  if (!legsPassed) {
    console.log(
      `  legs: run settled=${verdict.legs.runSettled}, ` +
        `task not waiting=${verdict.legs.taskNotWaiting}, ` +
        `agent not stuck=${verdict.legs.agentNotStuck}`,
    );
  }
  console.log(`  evidence: ${JSON.stringify(verdict.evidence)}`);
  if (setExitCode) {
    verdictExitCode = legsPassed && withinBudget ? 0 : 1;
    process.exitCode = verdictExitCode;
  }
}

interface RunRow {
  id: string;
  status: string;
  error_code: string | null;
  finished_at: Date | null;
  context_snapshot: { issueId?: string; taskKey?: string } | null;
}
interface IssueRow {
  id: string;
  identifier: string | null;
  status: string;
}
interface AgentRow {
  id: string;
  name: string;
  status: string;
  company_id: string;
}
interface WakeRow {
  id: string;
  reason: string | null;
  status: string;
  source: string;
  created_at: Date;
}

export interface ScenarioState {
  run: RunRow | null;
  issue: IssueRow | null;
  agent: AgentRow | null;
  wakes: WakeRow[];
  liveRuns: Array<{ id: string; status: string }>;
  resumes: Array<{ id: string; action: string; created_at: Date }>;
}

/** One read of the situation the scenario watches: the run, its task, the agent. */
async function readState(
  db: Db,
  ids: { companyId: string; agentId: string; issueId: string; runId: string },
): Promise<ScenarioState> {
  const sql = sqlOf(db);
  const [runs, issueRows, agentRows, wakes, allRuns, resumes] = await Promise.all([
    sql`select id, status, error_code, finished_at, context_snapshot
        from heartbeat_runs where id = ${ids.runId}`,
    sql`select id, identifier, status from issues where id = ${ids.issueId}`,
    sql`select id, name, status, company_id from agents where id = ${ids.agentId}`,
    sql`select id, reason, status, source, created_at from agent_wakeup_requests
        where company_id = ${ids.companyId} and payload ->> 'issueId' = ${ids.issueId}`,
    sql`select id, status from heartbeat_runs where agent_id = ${ids.agentId}`,
    sql`select id, action, created_at from activity_log
        where company_id = ${ids.companyId} and action = 'agent.auto_resume_issued'`,
  ]);
  return {
    run: (runs[0] as RunRow | undefined) ?? null,
    issue: (issueRows[0] as IssueRow | undefined) ?? null,
    agent: (agentRows[0] as AgentRow | undefined) ?? null,
    wakes: wakes as WakeRow[],
    liveRuns: (allRuns as Array<{ id: string; status: string }>).filter(
      (row) => row.id !== ids.runId && ["queued", "running", "scheduled_retry"].includes(row.status),
    ),
    resumes: resumes as Array<{ id: string; action: string; created_at: Date }>,
  };
}

/** The three legs of the verdict, computed from one database read. */
function legsOf(state: ScenarioState) {
  const runSettled = !["queued", "running", "scheduled_retry"].includes(
    state.run?.status ?? "running",
  );
  const taskNotWaiting =
    state.issue?.status !== "in_progress" && (state.wakes.length > 0 || state.liveRuns.length > 0);
  const agentNotStuck = state.agent?.status !== "error" || state.resumes.length > 0;
  return { runSettled, taskNotWaiting, agentNotStuck };
}

async function rehearse(flags: ReturnType<typeof parseFlags>) {
  // `--db` rehearses against a database the caller already has (a scratch
  // database on the stand, for instance); without it the run starts its own
  // throwaway embedded Postgres, the same one the test suite uses.
  // Importing the embedded-Postgres runtime installs global exit hooks as a side
  // effect, and those hooks own the process exit path: they would drop a FAIL's
  // exit code. Paperclip stops its own clusters explicitly (the `finally` below),
  // so the hooks are removed the way the database package's own lifecycle helper
  // removes them.
  const embedded = flags.db
    ? null
    : await loadWithoutEmbeddedPostgresExitHooks(() =>
        startEmbeddedPostgresTestDatabase("myrmidon-stand-recovery-"),
      );
  const dbUrl = flags.db ?? embedded!.connectionString;
  const db = createDb(dbUrl);
  const sql = sqlOf(db);
  await withTimeout("the scenario database", 30_000, sql`select 1`);
  const milestones: Milestone[] = [];
  // The kill is the zero of the scenario: the ticket's 10 minutes run from the
  // moment the gateway died, not from the start of the rehearsal.
  const killedAt = new Date();
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();

  try {
    // The knobs go through the product's own settings API: the stall threshold
    // has to fit the budget and the pickup pass has to be able to look often
    // enough. Nothing is applied to a live object — the three passes read the
    // row on every pass, which is what this rehearsal demonstrates.
    const settings = await teamLivenessService(db).update(
      {
        runStallEnabled: true,
        autoResumeEnabled: true,
        idlePickupEnabled: true,
        runStallThresholdSec: flags.stallSec ?? 120,
        idlePickupIntervalSec: 5,
        idlePickupWakeBudgetPerMin: 5,
        idlePickupWakeBatch: 5,
      },
      {
        actorType: "system",
        actorId: "stand-recovery-scenario",
        agentId: null,
        runId: null,
        agentApiKeyId: null,
      },
    );
    console.log(
      `knobs (instance settings): stall ${settings.settings.runStallThresholdSec}s, ` +
        `pickup every ${settings.settings.idlePickupIntervalSec}s, ` +
        `wake budget ${settings.settings.idlePickupWakeBudgetPerMin}/min`,
    );

    // Every wake carries a responsible user: without one the board refuses the
    // wake itself (422 `responsible_user_unresolved`), which is a real
    // pre-condition of the wake path and not something the scenario may skip.
    const ownerUserId = "stand-scenario-owner";
    await sql`insert into companies (id, name, issue_prefix, require_board_approval_for_new_agents,
        default_responsible_user_id)
      values (${companyId}, 'stand-scenario', 'STD', false, ${ownerUserId})`;
    await sql`insert into agents (id, company_id, name, role, status, adapter_type,
        adapter_config, runtime_config, permissions)
      values (${agentId}, ${companyId}, 'stand-agent', 'engineer', 'running', 'codex_local',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
    await sql`insert into issues (id, company_id, identifier, title, status, priority,
        assignee_agent_id, responsible_user_id)
      values (${issueId}, ${companyId}, 'STD-1',
        'stand scenario: work in flight when the gateway died', 'in_progress', 'high',
        ${agentId}, ${ownerUserId})`;

    // A real process holds the run: the gateway. From the board's side this is
    // the ordinary picture of a run in flight — a live pid and progress
    // recorded right up to the last second.
    const gateway: ChildProcess = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 3600000)"],
      { stdio: "ignore" },
    );
    const contextSnapshot = JSON.stringify({ issueId, taskKey: issueId });
    await sql`insert into heartbeat_runs (id, company_id, agent_id, status, invocation_source,
        context_snapshot, started_at, process_started_at, process_pid, last_output_at, last_useful_action_at)
      values (${runId}, ${companyId}, ${agentId}, 'running', 'assignment',
        ${contextSnapshot}::jsonb, ${new Date(killedAt.getTime() - 60_000).toISOString()},
        ${new Date(killedAt.getTime() - 60_000).toISOString()}, ${gateway.pid ?? null},
        ${killedAt.toISOString()}, ${killedAt.toISOString()})`;
    milestones.push({
      atMs: 0,
      line:
        `gateway killed mid-run: pid ${gateway.pid} SIGKILLed, run ${runId.slice(0, 8)} ` +
        "left running with progress up to t+0",
    });
    gateway.kill("SIGKILL");

    const heartbeat = heartbeatService(db);
    const stallSweep = createRunStallSweepFromHeartbeat({
      db,
      heartbeat,
      issues: issueService(db),
    });

    let state = await readState(db, { companyId, agentId, issueId, runId });
    let seen = legsOf(state);
    let recoveredMs: number | null = null;

    const record = (atMs: number, next: ScenarioState) => {
      const legs = legsOf(next);
      if (!seen.runSettled && legs.runSettled) {
        milestones.push({
          atMs,
          line: `run settled by the board: ${next.run?.status} errorCode=${next.run?.error_code ?? "none"}`,
        });
      }
      if (state.issue?.status === "in_progress" && next.issue?.status !== "in_progress") {
        milestones.push({
          atMs,
          line: `task taken out of in_progress by the board: ${next.issue?.status}`,
        });
      }
      const wake = next.wakes.find((row) => !state.wakes.some((before) => before.id === row.id));
      if (wake) {
        milestones.push({
          atMs,
          line: `wake queued for the task: reason=${wake.reason} source=${wake.source}`,
        });
      }
      if (state.agent?.status === "error" && next.agent?.status !== "error") {
        milestones.push({
          atMs,
          line: `agent lifted out of error by the board: status=${next.agent?.status}`,
        });
      }
      seen = legs;
      state = next;
      return legs;
    };

    for (let stepMs = 5_000; stepMs <= flags.budgetMs; stepMs += 5_000) {
      const now = new Date(killedAt.getTime() + stepMs);
      await stallSweep.sweep({ now, force: true });
      await heartbeat.sweepAutoResume(now);
      await heartbeat.sweepIdlePickup(now);
      const legs = record(stepMs, await readState(db, { companyId, agentId, issueId, runId }));
      if (stepMs % 60_000 === 0) {
        // Progress for whoever is watching the stand: without it a stuck pass
        // looks exactly like a slow one.
        console.log(
          `  … t+${minutes(stepMs)}: run=${state.run?.status} task=${state.issue?.status} ` +
            `agent=${state.agent?.status} wakes=${state.wakes.length}`,
        );
      }
      if (legs.runSettled && legs.taskNotWaiting && legs.agentNotStuck) {
        recoveredMs = stepMs;
        break;
      }
    }
    if (recoveredMs === null) {
      milestones.push({
        atMs: flags.budgetMs,
        line:
          `budget spent without recovery: run=${state.run?.status} task=${state.issue?.status} ` +
          `agent=${state.agent?.status} wakes=${state.wakes.length}`,
      });
    }

    printVerdict(
      {
        mode: "rehearse",
        recoveredMs,
        budgetMs: flags.budgetMs,
        legs: legsOf(state),
        milestones,
        evidence: {
          db: flags.db
            ? dbUrl.replace(/:\/\/[^@]*@/, "://***@")
            : "throwaway embedded postgres (dropped)",
          killedAt: killedAt.toISOString(),
          runStatus: state.run?.status,
          runErrorCode: state.run?.error_code,
          taskStatus: state.issue?.status,
          agentStatus: state.agent?.status,
          wakesForTask: state.wakes.map((row) => row.reason),
          wakeBudgetPerMin: settings.settings.idlePickupWakeBudgetPerMin,
        },
      },
      flags.json,
    );
    if (flags.thenWatch) {
      // The operator's half of the stand scenario, over the very database the
      // rehearsal just shaped: the same three legs, read-only.
      console.log("");
      console.log("watch verdict on the same database (read-only):");
      console.log(
        "  (the rehearsal moved the clock itself: read the legs here, the door-to-door " +
          "duration in `watch` against a live board)",
      );
      await watchVerdict(db, {
        since: killedAt,
        agent: "stand-agent",
        budgetMs: flags.budgetMs,
        json: flags.json,
        secondary: true,
      });
    }
    await closeRegisteredClients(dbUrl);
  } finally {
    if (!flags.db) await embedded?.cleanup().catch(() => undefined);
  }
}

interface WatchOptions {
  since: Date;
  agent: string | null;
  budgetMs: number;
  json: boolean;
  /** A verdict printed next to another one: it reports, it does not decide. */
  secondary?: boolean;
}

/** The read-only verdict over one database; shared by `watch` and `--then-watch`. */
async function watchVerdict(db: Db, options: WatchOptions) {
  const since = options.since;
  const sql = sqlOf(db);
  const milestones: Milestone[] = [];

  const agentRows = (
    options.agent
      ? await sql`select id, name, status, company_id from agents
          where id::text = ${options.agent} or name = ${options.agent}`
      : await sql`select id, name, status, company_id from agents`
  ) as AgentRow[];
  if (agentRows.length === 0) {
    throw new Error(`watch: no agent matches ${options.agent}`);
  }

  // The run the kill landed on: the newest run of the agent that was already
  // started when the gateway died.
  let state: ScenarioState | null = null;
  for (const agent of agentRows) {
    const candidates = (await sql`select id, context_snapshot from heartbeat_runs
        where agent_id = ${agent.id} and started_at <= ${since.toISOString()}
        order by started_at desc limit 1`) as Array<{
      id: string;
      context_snapshot: { issueId?: string } | null;
    }>;
    const runId = candidates[0]?.id;
    const issueId = candidates[0]?.context_snapshot?.issueId;
    if (!runId || !issueId || state) continue;
    state = await readState(db, { companyId: agent.company_id, agentId: agent.id, issueId, runId });
    milestones.push({
      atMs: 0,
      line:
        `killed run: ${runId.slice(0, 8)} (agent ${agent.name}, ` +
        `task ${state.issue?.identifier ?? issueId.slice(0, 8)})`,
    });
  }
  if (!state) {
    throw new Error("watch: no run of a matched agent was in flight when the gateway was killed");
  }

  const legs = legsOf(state);
  const after = (value: Date | null | undefined) =>
    value && new Date(value).getTime() >= since.getTime() ? new Date(value).getTime() : null;
  const stamps = [
    ...(legs.runSettled ? [after(state.run?.finished_at)] : []),
    ...state.wakes.map((row) => after(row.created_at)),
    ...state.resumes.map((row) => after(row.created_at)),
  ].filter((value): value is number => value !== null);
  const recoveredMs = stamps.length > 0 ? Math.max(...stamps) - since.getTime() : null;

  const settledAt = after(state.run?.finished_at);
  milestones.push({
    atMs: settledAt ? settledAt - since.getTime() : 0,
    line: `run now ${state.run?.status} errorCode=${state.run?.error_code ?? "none"}`,
  });
  milestones.push({
    atMs: 0,
    line:
      `task now ${state.issue?.status} (wakes for it: ` +
      `${state.wakes.map((row) => row.reason).join(", ") || "none"})`,
  });
  milestones.push({
    atMs: 0,
    line: `agent now ${state.agent?.status} (auto-resumes since the kill: ${state.resumes.length})`,
  });

  printVerdict(
    {
      mode: "watch",
      recoveredMs,
      budgetMs: options.budgetMs,
      legs,
      milestones,
      evidence: {
        since: since.toISOString(),
        runStatus: state.run?.status,
        runErrorCode: state.run?.error_code,
        taskStatus: state.issue?.status,
        agentStatus: state.agent?.status,
        wakesForTask: state.wakes.map((row) => row.reason),
      },
    },
    options.json,
    // A secondary verdict (rehearse --then-watch) reports; it does not decide.
    options.secondary !== true,
  );
}

async function watch(flags: ReturnType<typeof parseFlags>) {
  if (!flags.since) {
    console.error("watch needs --since <iso>: the moment the operator killed the gateway.");
    process.exit(2);
  }
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:***@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  await watchVerdict(db, {
    since: flags.since,
    agent: flags.agent,
    budgetMs: flags.budgetMs,
    json: flags.json,
  });
  await closeRegisteredClients(dbUrl);
}

async function main() {
  const flags = parseFlags();
  // Nothing here may run forever: a hang has to read as a FAIL, with the reason,
  // instead of an operator waiting on a silent terminal.
  const hardDeadline = setTimeout(() => {
    console.error(
      `FAIL: the scenario did not finish within ${(flags.budgetMs + 300_000) / 60_000} minutes of wall clock`,
    );
    process.exit(1);
  }, flags.budgetMs + 300_000);
  hardDeadline.unref?.();
  if (flags.mode === "rehearse") await rehearse(flags);
  else await watch(flags);
  clearTimeout(hardDeadline);
  if (verdictExitCode !== null) process.exitCode = verdictExitCode;
}

void main().catch((error) => {
  console.error(`stand scenario failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
