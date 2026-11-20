// server/src/myrmidon/evals/routes.ts
//
// myrmidon(1.6-EVALS): the board-facing REST API.
//
//   GET  /api/myrmidon/companies/:companyId/evals/tasks?role
//   POST /api/myrmidon/companies/:companyId/evals/seed            (board only)
//   POST /api/myrmidon/companies/:companyId/evals/runs            (board only)
//   POST /api/myrmidon/companies/:companyId/evals/runs/:runId/confirm  (board only, answers required)
//   POST /api/myrmidon/companies/:companyId/evals/verdict         (board only)
//   GET  /api/myrmidon/companies/:companyId/evals/runs?role&limit
//   GET  /api/myrmidon/companies/:companyId/evals/runs/:runId
//   POST /api/myrmidon/companies/:companyId/evals/caste-models/:casteKey/rank  (board only)
//   POST /api/myrmidon/companies/:companyId/evals/caste-models/:casteKey/apply (board only, owner grade)
//
// Reads need company access; run mutations need a board actor (they spend
// real gateway calls). While the judge contour is not configured, reads
// still work and mutations answer 503 with the reason, so the board can say
// why the button is disabled instead of showing a bare 500.

import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { agents } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/index.js";
import {
  createEvalsService,
  type EvalsService,
  type EvalRunInput,
  type EvalRunSubject,
} from "./service.js";
import { createJudge, DEFAULT_EVALS_MODEL, evalsSettingsProblem, readEvalsSettings, type EvalsSettings } from "./judge.js";
import { createLangfuseScoreExporter, noopScoreExporter, readLangfuseExportSettings } from "./langfuse.js";
import { ENGINEER_REFERENCE_TASKS, EVALS_PILOT_ROLE, seedReferenceTasks } from "./seed.js";
import { isEvalVerdict } from "./domain.js";
import { ADAPTER_SPECIAL_MODEL_VALUES } from "../agent-model-validation.js";
import { approverKindFromRequest } from "../approver-kind.js";
import { approverKindSatisfies } from "../knowledge/domain.js";
import { badRequest, forbidden, notFound, HttpError } from "../../errors.js";
import { createCasteService } from "../castes/service.js";
import {
  createCandidateAnswerGenerator,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  freeEnabledModels,
  type GenerateCandidateAnswer,
} from "./caste-models.js";
import { CASTE_MODEL_EVAL_SUBJECT_PREFIX } from "./caste-models-shared.js";

export interface EvalsRoutesDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Resolves the company secret named by MYRMIDON_EVALS_KEY_SECRET; null when missing. */
  readCompanyKey(companyId: string, secretName: string): Promise<string | null>;
  service?: EvalsService;
  /**
   * myrmidon(1.6.5 EVALS-JUDGE-FAMILY): resolves the model of the subject —
   * the agent whose work is judged — for the sameFamily flag. Tests inject a
   * stub; production reads the agent card of the role
   * (`subjectModelFromAgentCard`). Never the judge's own model.
   */
  subjectModelFor?(input: EvalRunSubject): string | undefined | Promise<string | undefined>;
  /**
   * 1.8 CASTE-MODEL-EVAL: generates one candidate answer for one reference
   * task on a free model. Tests inject a stub; production calls the same
   * LiteLLM contour as the judge.
   */
  generateCandidateAnswer?: GenerateCandidateAnswer;
  now(): Date;
}

export const EVALS_ACTOR_ID = "myrmidon-evals";

function parseRunInput(body: unknown): EvalRunInput | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.role !== "string" || b.role.trim().length === 0) return { error: "role is required" };
  if (typeof b.subject !== "string" || b.subject.trim().length === 0) return { error: "subject is required" };
  if (typeof b.answers !== "object" || b.answers === null) return { error: "answers is required (task slug -> text)" };
  for (const [slug, value] of Object.entries(b.answers)) {
    if (typeof value !== "string") return { error: `answers["${slug}"] must be a string` };
  }
  let ciPassRate: number | null = null;
  if (b.ciPassRate !== undefined && b.ciPassRate !== null) {
    if (typeof b.ciPassRate !== "number" || !Number.isFinite(b.ciPassRate) || b.ciPassRate < 0 || b.ciPassRate > 100) {
      return { error: "ciPassRate must be a number 0-100" };
    }
    ciPassRate = b.ciPassRate;
  }
  if (b.baselineRunId !== undefined && b.baselineRunId !== null && typeof b.baselineRunId !== "string") {
    return { error: "baselineRunId must be a string" };
  }
  if (b.thresholdDrop !== undefined && b.thresholdDrop !== null) {
    if (typeof b.thresholdDrop !== "number" || !Number.isFinite(b.thresholdDrop) || b.thresholdDrop < 0 || b.thresholdDrop > 100) {
      return { error: "thresholdDrop must be a number 0-100" };
    }
  }
  return {
    companyId: "", // filled by the route
    role: b.role.trim(),
    subject: b.subject.trim(),
    answers: b.answers as Record<string, string>,
    ciPassRate,
    baselineRunId: typeof b.baselineRunId === "string" ? b.baselineRunId : null,
    thresholdDrop: typeof b.thresholdDrop === "number" ? b.thresholdDrop : undefined,
  };
}

/**
 * myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the subject's model — the model of the
 * agent whose work is judged, read from the agent card of the evaluated role.
 *
 * The badge compares the judge with this value, so it must never be the judge
 * model: while the old code passed the judge's own model, `sameFamily` was true
 * for every subject under the default qwen-plus-free judge. A missing agent, a
 * missing model, or a value that only means "let the adapter decide" answers
 * undefined, and the badge is simply not shown instead of guessing.
 */
export async function subjectModelFromAgentCard(
  db: Db,
  companyId: string,
  input: EvalRunSubject,
): Promise<string | undefined> {
  const role = input.role.trim();
  if (!role) return undefined;
  const rows = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, role)))
    // Several agents can share a role; the first one is a stable choice and the
    // model is the same across the role's cards in practice.
    .orderBy(asc(agents.createdAt))
    .limit(1);
  const config = rows[0]?.adapterConfig;
  const model = config && typeof config.model === "string" ? config.model.trim() : "";
  if (!model || ADAPTER_SPECIAL_MODEL_VALUES.includes(model)) return undefined;
  return model;
}

export function myrmidonEvalsRoutes(db: Db, deps: Partial<EvalsRoutesDeps> = {}) {
  const router = Router();
  const env = deps.env ?? process.env;
  const settings = (): EvalsSettings => readEvalsSettings(env);
  const now = deps.now ?? (() => new Date());

  // myrmidon(1.6-EVALS): resolve the gateway key per company on every call,
  // not once for a placeholder company at service-build time.
  async function buildService(companyId: string): Promise<{ service: EvalsService; problem: string | null }> {
    if (deps.service) return { service: deps.service, problem: null };
    const current = settings();
    const problem = evalsSettingsProblem(current);
    // myrmidon(1.6.5 EVALS-JUDGE-FAMILY): sameFamily compares the judge with
    // the *subject* — the agent of this role, from its agent card. The old
    // `subjectModel: current.model` passed the judge model, so the judge was
    // compared with itself and the flag was true for every run.
    const subjectModelFor =
      deps.subjectModelFor ?? ((input: EvalRunSubject) => subjectModelFromAgentCard(db, companyId, input));
    if (problem) {
      // Still return a service bound to a heuristic judge? No — mutations
      // must refuse instead of silently scoring with a fake. Reads only.
      return { service: createEvalsService(db, { judge: createJudge({ fetch: fetch, apiKey: "", baseUrl: "http://127.0.0.1:9", model: DEFAULT_EVALS_MODEL, timeoutMs: 1 }), model: current.model, subjectModelFor, now }), problem };
    }
    const readCompanyKey =
      deps.readCompanyKey ??
      (async (companyId: string, secretName: string) => {
        const secrets = secretService(db);
        const row = await secrets.getByName(companyId, secretName);
        if (!row) return null;
        return secrets.resolveSecretValue(companyId, row.id, "latest");
      });
        const key = current.keySecret ? await readCompanyKey(companyId, current.keySecret) : null;
    if (!key) {
      return {
        service: createEvalsService(db, { judge: createJudge({ fetch: fetch, apiKey: "", baseUrl: "http://127.0.0.1:9", model: DEFAULT_EVALS_MODEL, timeoutMs: 1 }), model: current.model, subjectModelFor, now }),
        problem: `the evals API key secret "${current.keySecret ?? "—"}" is not available`,
      };
    }
    const exporter = current.langfuseExport
      ? (() => {
          const lf = readLangfuseExportSettings(env);
          return lf.enabled && lf.baseUrl && lf.publicKey
            ? createLangfuseScoreExporter({ fetch: deps.fetch ?? fetch, baseUrl: lf.baseUrl, publicKey: lf.publicKey, timeoutMs: lf.timeoutMs })
            : noopScoreExporter;
        })()
      : noopScoreExporter;
    return {
      service: createEvalsService(db, {
        judge: createJudge({
          fetch: deps.fetch ?? fetch,
          apiKey: key,
          baseUrl: current.baseUrl!,
          // myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the whole priority list goes
          // into the judge so a gateway error on one candidate falls through
          // to the next instead of aborting the run; the head is still the
          // recorded model. The list is re-read on every call, so a change
          // takes effect on the next run without a restart.
          model: current.judgeModels[0] ?? current.model,
          judgeModels: current.judgeModels,
          timeoutMs: current.timeoutMs,
        }),
        exporter,
        model: current.judgeModels[0] ?? current.model,
        subjectModelFor,
        now,
      }),
      problem: null,
    };
  }

  router.get("/myrmidon/companies/:companyId/evals/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const role = typeof req.query.role === "string" ? req.query.role : EVALS_PILOT_ROLE;
    const { service } = await buildService(companyId);
    const tasks = await service.loadTasks(companyId, role);
    res.json({ role, count: tasks.length, tasks });
  });

  router.post("/myrmidon/companies/:companyId/evals/seed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const role = typeof req.body?.role === "string" && req.body.role.trim() ? req.body.role.trim() : EVALS_PILOT_ROLE;
    const result = await seedReferenceTasks(db, companyId, role, ENGINEER_REFERENCE_TASKS);
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: EVALS_ACTOR_ID,
      action: "evals.seeded",
      entityType: "eval_reference_tasks",
      entityId: role,
      details: { ...result },
    });
    res.json(result);
  });

  router.post("/myrmidon/companies/:companyId/evals/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = parseRunInput(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { service, problem } = await buildService(companyId);
    if (problem) {
      res.status(503).json({ error: problem, enabled: false });
      return;
    }
    try {
      const outcome = await service.runEval({ ...parsed, companyId });
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: EVALS_ACTOR_ID,
        action: "evals.run_completed",
        entityType: "eval_run",
        entityId: outcome.run.id,
        details: {
          role: outcome.run.role,
          subject: outcome.run.subject,
          verdict: outcome.run.verdict,
          scorePercent: outcome.run.scores?.scorePercent ?? null,
          needsConfirm: outcome.needsConfirm,
        },
      });
      res.json(outcome);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.post("/myrmidon/companies/:companyId/evals/runs/:runId/confirm", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const { service, problem } = await buildService(companyId);
    if (problem) {
      res.status(503).json({ error: problem, enabled: false });
      return;
    }
    // myrmidon(1.6-EVALS): answers are not persisted with the run, so a
    // confirmation re-run must carry them again. Without this the fallback
    // would score every task zero and could "confirm" a regression that
    // never existed.
    if (typeof req.body?.answers !== "object" || req.body.answers === null || Array.isArray(req.body.answers)) {
      res.status(400).json({ error: "answers is required for a confirmation run (task slug -> text)" });
      return;
    }
    const answers = req.body.answers as Record<string, string>;
    for (const [slug, value] of Object.entries(answers)) {
      if (typeof value !== "string") {
        res.status(400).json({ error: `answers["${slug}"] must be a string` });
        return;
      }
    }
    try {
      const outcome = await service.runConfirmation(req.params.runId as string, answers);
      if (outcome.run.companyId !== companyId) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: EVALS_ACTOR_ID,
        action: "evals.run_confirmed",
        entityType: "eval_run",
        entityId: outcome.run.id,
        details: {
          role: outcome.run.role,
          subject: outcome.run.subject,
          verdict: outcome.run.verdict,
          scorePercent: outcome.run.scores?.scorePercent ?? null,
        },
      });
      res.json(outcome);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.post("/myrmidon/companies/:companyId/evals/verdict", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.role !== "string" || typeof b.subject !== "string" || typeof b.baselineRunId !== "string") {
      res.status(400).json({ error: "role, subject and baselineRunId are required" });
      return;
    }
    const { service } = await buildService(companyId);
    try {
      const verdict = await service.verdictForCandidate({
        companyId,
        role: b.role,
        subject: b.subject,
        baselineRunId: b.baselineRunId,
        thresholdDrop: typeof b.thresholdDrop === "number" ? b.thresholdDrop : undefined,
      });
      res.json(verdict);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.get("/myrmidon/companies/:companyId/evals/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;
    const { service } = await buildService(companyId);
    const runs = await service.listRuns(companyId, role, limit);
    res.json({ runs });
  });

  router.get("/myrmidon/companies/:companyId/evals/runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { service } = await buildService(companyId);
    const run = await service.getRun(companyId, req.params.runId as string);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ run });
  });


  // 1.8 CASTE-MODEL-EVAL: the candidate-answer generator for the rank run.
  // Tests inject `deps.generateCandidateAnswer`; production calls the same
  // LiteLLM contour as the judge, with the company key.
  async function buildCandidateGenerator(
    companyId: string,
  ): Promise<{ generateAnswer: GenerateCandidateAnswer | null; problem: string | null }> {
    if (deps.generateCandidateAnswer) return { generateAnswer: deps.generateCandidateAnswer, problem: null };
    const current = settings();
    const problem = evalsSettingsProblem(current);
    if (problem) return { generateAnswer: null, problem };
    const readCompanyKey =
      deps.readCompanyKey ??
      (async (id: string, secretName: string) => {
        const secrets = secretService(db);
        const row = await secrets.getByName(id, secretName);
        return row ? secrets.resolveSecretValue(id, row.id, "latest") : null;
      });
    const key = current.keySecret ? await readCompanyKey(companyId, current.keySecret) : null;
    if (!key || !current.baseUrl) {
      return {
        generateAnswer: null,
        problem: `the evals API key secret "${current.keySecret ?? "—"}" is not available`,
      };
    }
    return {
      generateAnswer: createCandidateAnswerGenerator({
        fetch: deps.fetch ?? fetch,
        apiKey: key,
        baseUrl: current.baseUrl,
      }),
      problem: null,
    };
  }

  // 1.8 CASTE-MODEL-EVAL: rank the company's free+enabled models on the
  // caste's reference set. Each model gets one persisted eval run, so the
  // apply route can re-verify the model/run pairing afterwards.
  router.post("/myrmidon/companies/:companyId/evals/caste-models/:casteKey/rank", async (req, res) => {
    const companyId = req.params.companyId as string;
    const casteKey = req.params.casteKey as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const { service, problem } = await buildService(companyId);
    if (problem) {
      res.status(503).json({ error: problem, enabled: false });
      return;
    }
    const { generateAnswer, problem: generatorProblem } = await buildCandidateGenerator(companyId);
    if (generatorProblem || !generateAnswer) {
      res.status(503).json({ error: generatorProblem ?? "candidate generation is not configured", enabled: false });
      return;
    }
    let tasks;
    try {
      tasks = await service.loadTasks(companyId, casteKey);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
      return;
    }
    if (tasks.length === 0) {
      res.status(404).json({ error: `no reference tasks for role "${casteKey}"` });
      return;
    }
    const models = await freeEnabledModels(db, companyId);
    const rows: Array<{ model: string; litellmModelName: string; runId: string; scorePercent: number }> = [];
    const failed: string[] = [];
    for (const model of models) {
      const answers: Record<string, string> = {};
      let modelFailed = false;
      for (const task of tasks) {
        try {
          // Never log the model response; only the fact of the failure.
          answers[task.slug] = await generateAnswer({ model, prompt: task.prompt, timeoutMs: DEFAULT_CANDIDATE_TIMEOUT_MS });
        } catch {
          modelFailed = true;
          break;
        }
      }
      if (modelFailed) {
        failed.push(model.modelName);
        continue;
      }
      try {
        const outcome = await service.runEval({
          companyId,
          role: casteKey,
          subject: `${CASTE_MODEL_EVAL_SUBJECT_PREFIX}${model.modelName}`,
          answers,
        });
        const scorePercent = outcome.run.scores?.scorePercent;
        if (typeof scorePercent !== "number") {
          failed.push(model.modelName);
          continue;
        }
        rows.push({ model: model.modelName, litellmModelName: model.litellmModelName, runId: outcome.run.id, scorePercent });
      } catch {
        failed.push(model.modelName);
      }
    }
    rows.sort((a, b) => b.scorePercent - a.scorePercent || a.model.localeCompare(b.model));
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: EVALS_ACTOR_ID,
      action: "evals.caste_models_ranked",
      entityType: "caste",
      entityId: casteKey,
      details: { casteKey, ranked: rows.length, failed: failed.length },
    });
    res.json({ casteKey, rows, failed });
  });

  // 1.8 CASTE-MODEL-EVAL: write `agent_castes.default_model` from a ranking
  // run. Owner grade only (the default model steers every new agent of the
  // caste); the run must be this company's completed ranking run of the very
  // model, so the caller cannot apply a score it made up.
  router.post("/myrmidon/companies/:companyId/evals/caste-models/:casteKey/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    const casteKey = req.params.casteKey as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const presented = approverKindFromRequest(req, companyId);
    if (!approverKindSatisfies("owner", presented)) {
      throw forbidden("changing a caste default model requires the owner", {
        code: "approver_kind_mismatch",
        required: "owner",
        presented: presented ?? "none",
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.model !== "string" || !body.model.trim() || typeof body.runId !== "string" || !body.runId.trim()) {
      throw badRequest("model and runId are required");
    }
    const model = body.model.trim();
    const runId = body.runId.trim();
    const { service, problem } = await buildService(companyId);
    if (problem) {
      res.status(503).json({ error: problem, enabled: false });
      return;
    }
    const run = await service.getRun(companyId, runId);
    if (!run || run.companyId !== companyId) {
      throw notFound("run not found");
    }
    if (run.status !== "completed") {
      throw badRequest(`run ${runId} is not completed`, { code: "eval_run_not_completed" });
    }
    if (run.role !== casteKey || run.subject !== `${CASTE_MODEL_EVAL_SUBJECT_PREFIX}${model}`) {
      throw badRequest("the run is not a completed ranking run of this model on this caste", {
        code: "eval_run_model_mismatch",
      });
    }
    const castes = createCasteService({ db, now });
    let caste;
    try {
      caste = await castes.updateCaste({ companyId, key: casteKey, body: { defaultModel: model } });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw notFound(`caste "${casteKey}" not found in this company`);
      }
      throw error;
    }
    const scorePercent = run.scores?.scorePercent ?? null;
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: EVALS_ACTOR_ID,
      action: "evals.caste_model_applied",
      entityType: "caste",
      entityId: casteKey,
      details: { casteKey, model, runId, scorePercent, appliedBy: presented ?? "owner" },
    });
    res.json({ caste, model, runId, scorePercent });
  });

  return router;
}
