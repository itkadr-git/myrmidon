// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): read-only client for the reference-task
// eval runs API (server/src/myrmidon/evals/routes.ts, board-facing).
//
// Only the reads the results screen needs: the run list already carries
// `scores.tasks[].sameFamily`, so the badge needs no second request.
import { api } from "@/api/client";

/** One reference task inside a run aggregate. */
export interface EvalTaskScoreView {
  taskSlug: string;
  /** Raw judge points per criterion: criterion name -> points awarded. */
  criteria: Record<string, number>;
  /** True when the judge and the evaluated agent share a model family. */
  sameFamily: boolean;
  rawScore: number;
  weight: number;
  maxScore: number;
}

/** The aggregate a run stores in `eval_runs.scores`. */
export interface EvalRunScoresView {
  tasks: EvalTaskScoreView[];
  totalScore: number;
  maxScore: number;
  scorePercent: number;
  taskCount: number;
  codeTaskCount: number;
}

/** An eval run row, as `GET /evals/runs` returns it. */
export interface EvalRunView {
  id: string;
  companyId: string;
  role: string;
  subject: string;
  kind: string;
  status: string;
  scores: EvalRunScoresView | null;
  verdict: string | null;
  verdictReason: string | null;
  /** The judge model recorded on the run. */
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const evalsRunsQueryKey = (companyId: string, role?: string, limit?: number) =>
  ["myrmidon", "evals", "runs", companyId, role ?? null, limit ?? null] as const;

export const myrmidonEvalsApi = {
  listRuns: (companyId: string, params: { role?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.role) search.set("role", params.role);
    if (params.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return api.get<{ runs: EvalRunView[] }>(
      `/myrmidon/companies/${companyId}/evals/runs${query ? `?${query}` : ""}`,
    );
  },
};