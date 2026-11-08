/**
 * STACK-UPDATES-B Release Reconciliation Module Types.
 *
 * Defines the public contracts for the daily release reconciliation service:
 * checking current release vs latest vendor tag on GitHub, and creating draft
 * tasks when a divergence is detected.
 */

export interface ReleaseReconciliationConfig {
  currentRelease: string | null;
  vendorRepo: string;
  gitHubApiBase: string;
  vendorTagOverride: string | null;
  gitHubToken: string | null;
  intervalSec: number;
  companyId: string | null;
}

export interface GitHubTagInfo {
  name: string;
  commitSha?: string;
}

export interface GitHubReleaseInfo {
  tagName: string;
  name?: string;
  body?: string;
  publishedAt?: string;
  htmlUrl?: string;
}

export interface GitHubClient {
  getLatestTag(repo: string): Promise<GitHubTagInfo | null>;
  getLatestRelease(repo: string): Promise<GitHubReleaseInfo | null>;
  getReleaseNotes?(repo: string, tagName: string): Promise<string | null>;
}

export interface DraftTaskPayload {
  companyId?: string;
  title: string;
  description: string;
  status: "backlog";
  priority?: "low" | "medium" | "high" | "urgent";
  metadata?: Record<string, unknown>;
}

export interface CreatedDraftTask {
  id: string;
  identifier?: string;
  title?: string;
}

export interface IssueDraftSink {
  createDraftTask(payload: DraftTaskPayload): Promise<CreatedDraftTask>;
  findExistingDraftTask?(titleOrKey: string): Promise<CreatedDraftTask | null>;
}

export interface ReconcileResult {
  currentRelease: string;
  vendorTag: string;
  diverged: boolean;
  draftTaskCreated: boolean;
  taskId?: string;
  taskIdentifier?: string;
  summary?: string;
  reason?: string;
}

export interface ReconcileOptions {
  env?: Record<string, string | undefined>;
  config?: Partial<ReleaseReconciliationConfig>;
  gitHubClient?: GitHubClient;
  issueSink?: IssueDraftSink;
  companyId?: string;
  now?: () => Date;
}

export interface ReleaseReconciliationServiceOptions extends ReconcileOptions {
  intervalSec?: number;
  timers?: {
    setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearInterval: (handle: NodeJS.Timeout) => void;
  };
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}
