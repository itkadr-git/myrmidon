import { AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import type { Issue } from "@myrmidon/shared";

interface ReleasePullRequest {
  workProductId: string;
  repo: string | null;
  number: number | null;
  url: string | null;
  state: string;
  mergeCommitSha: string | null;
  inDefaultBranch: boolean | null;
  verdict: "present" | "missing_from_release" | "no_release_label" | "unknown";
  releaseRefs: string[];
}
interface ReleaseStatus { issueId: string; releaseLabel: string | null; pullRequests: ReleasePullRequest[] }

export function ReleaseComposition({ issue }: { issue: Issue }) {
  const query = useQuery({
    queryKey: queryKeys.issues.releaseStatus(issue.id),
    queryFn: () => api.get<ReleaseStatus>(`/issues/${issue.id}/release-status`),
    enabled: issue.labels.some((label) => /^release(?::|\/|\s)\d+\.\d+$/i.test(label.name)),
  });
  if (!issue.labels.some((label) => /^release(?::|\/|\s)\d+\.\d+$/i.test(label.name))) return null;
  if (query.isLoading) return <div className="px-3 py-2 text-xs text-muted-foreground">Loading release composition…</div>;
  if (query.isError) return <div role="alert" className="px-3 py-2 text-xs text-destructive">Release composition unavailable.</div>;
  const prs = query.data?.pullRequests ?? [];
  if (prs.length === 0) return <div className="px-3 py-2 text-xs text-muted-foreground">No release pull requests found.</div>;
  const missingDone = issue.status === "done" && prs.some((pr) => pr.verdict === "missing_from_release");
  const releaseLabel = query.data?.releaseLabel ?? issue.labels.find((label) => /^release(?::|\/|\s)\d+\.\d+$/i.test(label.name))?.name.replace(/^release(?::|\/|\s)/i, "") ?? null;
  return <section aria-label="Release composition" className="space-y-2 rounded-md border border-border p-3">
    <h3 className="text-sm font-semibold">Release composition {releaseLabel ? `· ${releaseLabel}` : ""}</h3>
    {missingDone && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="size-4" />Done task has code missing from its release branch.</p>}
    <ul className="space-y-1">
      {prs.map((pr) => <li key={pr.workProductId} className="flex items-start gap-2 text-xs">
        {pr.verdict === "present" ? <CheckCircle2 className="size-4 text-success" /> : pr.verdict === "missing_from_release" ? <AlertTriangle className="size-4 text-destructive" /> : <CircleHelp className="size-4 text-muted-foreground" />}
        <span>{pr.url ? <a className="underline" href={pr.url} target="_blank" rel="noreferrer">{pr.repo ?? "Pull request"}#{pr.number ?? "?"}</a> : `${pr.repo ?? "Pull request"}#${pr.number ?? "?"}`} — {pr.verdict === "present" ? `Included in ${pr.releaseRefs.join(", ")}` : pr.verdict === "missing_from_release" ? "Merged in main, absent from release branch" : pr.verdict === "no_release_label" ? "No release label" : "Membership could not be verified"}</span>
      </li>)}
    </ul>
  </section>;
}
