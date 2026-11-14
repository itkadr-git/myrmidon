// ui/src/components/myrmidon/ReleaseFlakyWorkPanel.tsx
//
// myrmidon(1.8 RELEASE-STAGE): flaky CI work panel for releasing operators (OPE-13066).
// Follows DESIGN.md: semantic tokens only, one component per job, inline actionable errors.

import { useState } from "react";
import type {
  ReleaseFlakyGateState,
  ReleaseFlakyJob,
  ReleaseFlakyWaiver,
} from "@myrmidon/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { releaseFlakyWorkApi } from "@/api/releaseFlakyWork";

export interface ReleaseFlakyWorkPanelProps {
  initialState: ReleaseFlakyGateState;
  onStateChange?: (state: ReleaseFlakyGateState) => void;
}

export function ReleaseFlakyWorkPanel({
  initialState,
  onStateChange,
}: ReleaseFlakyWorkPanelProps) {
  const [state, setState] = useState<ReleaseFlakyGateState>(initialState);
  const [activeWaiverJob, setActiveWaiverJob] = useState<ReleaseFlakyJob | null>(null);
  const [waiverReason, setWaiverReason] = useState("");
  const [waiverHeadSha, setWaiverHeadSha] = useState("");
  const [waiverAttempt, setWaiverAttempt] = useState<number>(1);
  const [waiverUrl, setWaiverUrl] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateState = (newState: ReleaseFlakyGateState) => {
    setState(newState);
    onStateChange?.(newState);
  };

  const handleOpenWaiver = (job: ReleaseFlakyJob) => {
    setActiveWaiverJob(job);
    setWaiverReason("");
    setWaiverHeadSha(job.headSha);
    setWaiverAttempt(job.attempt);
    setWaiverUrl("");
    setActionError(null);
  };

  const handleCloseWaiver = () => {
    setActiveWaiverJob(null);
    setActionError(null);
  };

  const handleRetry = async (job: ReleaseFlakyJob) => {
    setIsSubmitting(true);
    setActionError(null);
    try {
      const updated = await releaseFlakyWorkApi.retryJob(state.releaseId, {
        jobId: job.id,
      });
      updateState(updated);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to retry CI job");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitWaiver = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWaiverJob) return;

    setIsSubmitting(true);
    setActionError(null);
    try {
      const updated = await releaseFlakyWorkApi.recordWaiver(state.releaseId, {
        job: activeWaiverJob.jobName,
        reason: waiverReason.trim(),
        evidence: {
          headSha: waiverHeadSha.trim(),
          job: activeWaiverJob.jobName,
          attempt: Number(waiverAttempt),
          url: waiverUrl.trim() || undefined,
        },
      });
      updateState(updated);
      handleCloseWaiver();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to record waiver");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResumeGate = async () => {
    setIsSubmitting(true);
    setActionError(null);
    try {
      const updated = await releaseFlakyWorkApi.resumeGate(state.releaseId);
      updateState(updated);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to resume release gate");
    } finally {
      setIsSubmitting(false);
    }
  };

  const isGateBlocked = !state.canResume || state.gateStatus === "blocked";

  return (
    <div className="flex flex-col gap-6" data-testid="release-flaky-panel">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>Release CI Gate & Flaky Work</CardTitle>
            <CardDescription>
              Release Candidate: <span className="font-mono">{state.releaseId}</span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant={isGateBlocked ? "destructive" : "default"}
              data-testid="gate-status-badge"
            >
              {state.gateStatus}
            </Badge>
            <Button
              variant="cta"
              size="sm"
              disabled={isGateBlocked || isSubmitting || state.gateStatus === "resumed"}
              onClick={handleResumeGate}
              data-testid="resume-gate-btn"
            >
              Resume Gate
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {actionError && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              data-testid="action-error-message"
            >
              {actionError}
            </div>
          )}

          {isGateBlocked && state.blockingReason && (
            <div
              className="rounded-md border border-border bg-muted p-3 text-sm text-foreground"
              data-testid="blocking-reason-callout"
            >
              <div className="font-medium">Gate Blocked</div>
              <div className="text-muted-foreground">{state.blockingReason}</div>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-foreground">CI Jobs</h3>
            {state.jobs.length === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="no-jobs-msg">
                No flaky CI jobs recorded for this release candidate.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {state.jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between rounded-md border border-border p-3"
                    data-testid={`job-row-${job.id}`}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {job.jobName}
                        </span>
                        <Badge
                          variant={
                            job.status === "failed"
                              ? "destructive"
                              : job.status === "waived"
                                ? "secondary"
                                : "default"
                          }
                          data-testid={`job-status-${job.id}`}
                        >
                          {job.status}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        head: <span className="font-mono">{job.headSha}</span> · attempt:{" "}
                        <span className="font-mono">{job.attempt}</span>
                        {job.failureDetail && ` · ${job.failureDetail}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {job.status === "failed" && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isSubmitting}
                            onClick={() => handleRetry(job)}
                            data-testid={`retry-job-btn-${job.id}`}
                          >
                            Retry
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isSubmitting}
                            onClick={() => handleOpenWaiver(job)}
                            data-testid={`open-waiver-btn-${job.id}`}
                          >
                            Waive with Evidence
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {activeWaiverJob && (
            <form
              onSubmit={handleSubmitWaiver}
              className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
              data-testid="waiver-form"
            >
              <h4 className="text-sm font-semibold text-foreground">
                Waive Flaky Failure: {activeWaiverJob.jobName}
              </h4>
              <p className="text-xs text-muted-foreground">
                Waivers require verifiable evidence linked to headSha, job, and attempt.
              </p>

              <div className="flex flex-col gap-1">
                <Label htmlFor="waiver-head-sha">Head SHA</Label>
                <Input
                  id="waiver-head-sha"
                  value={waiverHeadSha}
                  onChange={(e) => setWaiverHeadSha(e.target.value)}
                  required
                  data-testid="waiver-headsha-input"
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="waiver-attempt">Attempt</Label>
                <Input
                  id="waiver-attempt"
                  type="number"
                  min={1}
                  value={waiverAttempt}
                  onChange={(e) => setWaiverAttempt(parseInt(e.target.value, 10))}
                  required
                  data-testid="waiver-attempt-input"
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="waiver-reason">Reason / Justification</Label>
                <Input
                  id="waiver-reason"
                  placeholder="Explanation of why this failure is unrelated to release changes"
                  value={waiverReason}
                  onChange={(e) => setWaiverReason(e.target.value)}
                  required
                  data-testid="waiver-reason-input"
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="waiver-url">Evidence URL (CI Run / Logs)</Label>
                <Input
                  id="waiver-url"
                  type="url"
                  placeholder="https://..."
                  value={waiverUrl}
                  onChange={(e) => setWaiverUrl(e.target.value)}
                  data-testid="waiver-url-input"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCloseWaiver}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="cta"
                  size="sm"
                  disabled={isSubmitting || !waiverReason.trim()}
                  data-testid="submit-waiver-btn"
                >
                  Submit Waiver
                </Button>
              </div>
            </form>
          )}

          {state.waivers.length > 0 && (
            <div className="flex flex-col gap-2 pt-2">
              <h3 className="text-sm font-semibold text-foreground">Recorded Waivers</h3>
              <div className="flex flex-col gap-2" data-testid="waivers-list">
                {state.waivers.map((waiver: ReleaseFlakyWaiver, idx: number) => (
                  <div
                    key={`${waiver.job}-${idx}`}
                    className="rounded-md border border-border bg-muted/40 p-3 text-xs"
                    data-testid={`waiver-item-${idx}`}
                  >
                    <div className="flex items-center justify-between font-medium text-foreground">
                      <span>{waiver.job}</span>
                      <span className="text-muted-foreground">
                        {new Date(waiver.waivedAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="mt-1 text-muted-foreground">{waiver.reason}</div>
                    <div className="mt-1 font-mono text-muted-foreground">
                      head: {waiver.evidence.headSha} · attempt: {waiver.evidence.attempt}
                      {waiver.evidence.url && ` · ${waiver.evidence.url}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
