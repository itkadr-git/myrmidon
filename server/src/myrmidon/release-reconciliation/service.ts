/**
 * Core reconciliation logic and service for STACK-UPDATES-B.
 *
 * Compares current release with the latest vendor tag on GitHub, and if they diverge,
 * creates a draft task with a summary of changes.
 */

import { readReleaseReconciliationConfig } from "./config.js";
import { createDefaultGitHubClient, normaliseVersion } from "./github-client.js";
import type {
  CreatedDraftTask,
  DraftTaskPayload,
  IssueDraftSink,
  ReconcileOptions,
  ReconcileResult,
  ReleaseReconciliationServiceOptions,
} from "./types.js";

/**
 * In-memory / mock sink for testing or standalone operation.
 */
export class InMemoryIssueSink implements IssueDraftSink {
  public createdTasks: DraftTaskPayload[] = [];
  private nextId = 1;

  async createDraftTask(payload: DraftTaskPayload): Promise<CreatedDraftTask> {
    this.createdTasks.push(payload);
    const id = `mock-task-${this.nextId++}`;
    return {
      id,
      identifier: `DRAFT-${this.nextId - 1}`,
      title: payload.title,
    };
  }

  async findExistingDraftTask(titleOrKey: string): Promise<CreatedDraftTask | null> {
    const found = this.createdTasks.find(
      (t) => t.title === titleOrKey || t.title.includes(titleOrKey),
    );
    if (!found) return null;
    return { id: "existing-draft", title: found.title };
  }
}

/**
 * Format change summary body for the draft task.
 */
export function buildDraftTaskSummary(params: {
  vendorRepo: string;
  currentRelease: string;
  vendorTag: string;
  releaseNotes?: string | null;
  detectedAt?: Date;
}): string {
  const { vendorRepo, currentRelease, vendorTag, releaseNotes, detectedAt } = params;
  const timestamp = (detectedAt ?? new Date()).toISOString();

  const lines: string[] = [
    `## Сверка релизов вендора: обнаружено расхождение`,
    ``,
    `Автоматическая сверка стека зафиксировала доступность нового вендорского релиза.`,
    ``,
    `- **Репозиторий вендора:** \`${vendorRepo}\``,
    `- **Текущий релиз системы:** \`${currentRelease}\``,
    `- **Новый вендорский тег:** \`${vendorTag}\``,
    `- **Время обнаружения:** ${timestamp}`,
    ``,
  ];

  if (releaseNotes && releaseNotes.trim().length > 0) {
    lines.push(`### Сводка изменений / Release Notes`);
    lines.push(``);
    lines.push(releaseNotes.trim());
    lines.push(``);
  } else {
    lines.push(`### Сводка изменений`);
    lines.push(``);
    lines.push(`Release notes не были предоставлены вендором или описание отсутствует.`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Задача создана сервисом автоматической сверки релизов STACK-UPDATES-B в статусе черновика (backlog).*`);

  return lines.join("\n");
}

/**
 * Execute a single reconciliation pass.
 *
 * Compares currentRelease with latest vendor tag.
 * Returns ReconcileResult indicating whether mismatch occurred and whether draft task was created.
 */
export async function reconcileReleases(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const env = options.env ?? process.env;
  const baseConfig = readReleaseReconciliationConfig(env);
  const config = { ...baseConfig, ...(options.config ?? {}) };

  const currentReleaseRaw = config.currentRelease ?? "unknown";
  const currentReleaseNorm = normaliseVersion(currentReleaseRaw);

  const gitHubClient =
    options.gitHubClient ??
    createDefaultGitHubClient({
      apiBase: config.gitHubApiBase,
      token: config.gitHubToken,
    });

  const issueSink = options.issueSink ?? new InMemoryIssueSink();

  let vendorTagRaw: string | null = config.vendorTagOverride;
  let releaseNotes: string | null = null;

  if (!vendorTagRaw) {
    // Try latest release first, fallback to latest tag
    try {
      const latestRelease = await gitHubClient.getLatestRelease(config.vendorRepo);
      if (latestRelease?.tagName) {
        vendorTagRaw = latestRelease.tagName;
        releaseNotes = latestRelease.body ?? null;
      }
    } catch {
      // ignore and fallback to tags
    }

    if (!vendorTagRaw) {
      const latestTag = await gitHubClient.getLatestTag(config.vendorRepo);
      if (latestTag?.name) {
        vendorTagRaw = latestTag.name;
      }
    }
  }

  if (!vendorTagRaw) {
    return {
      currentRelease: currentReleaseRaw,
      vendorTag: "unknown",
      diverged: false,
      draftTaskCreated: false,
      reason: `Could not retrieve vendor tags for repo ${config.vendorRepo}`,
    };
  }

  const vendorTagNorm = normaliseVersion(vendorTagRaw);
  const diverged = currentReleaseNorm !== vendorTagNorm;

  if (!diverged) {
    return {
      currentRelease: currentReleaseRaw,
      vendorTag: vendorTagRaw,
      diverged: false,
      draftTaskCreated: false,
      reason: "Current release matches vendor tag",
    };
  }

  // Tags diverge: create draft task
  if (!releaseNotes && gitHubClient.getReleaseNotes) {
    try {
      releaseNotes = await gitHubClient.getReleaseNotes(config.vendorRepo, vendorTagRaw);
    } catch {
      // non-fatal
    }
  }

  const title = `[Обновление стека] Новый релиз вендора ${config.vendorRepo}: ${vendorTagRaw} (текущий: ${currentReleaseRaw})`;
  const description = buildDraftTaskSummary({
    vendorRepo: config.vendorRepo,
    currentRelease: currentReleaseRaw,
    vendorTag: vendorTagRaw,
    releaseNotes,
    detectedAt: options.now ? options.now() : new Date(),
  });

  const payload: DraftTaskPayload = {
    companyId: options.companyId ?? config.companyId ?? undefined,
    title,
    description,
    status: "backlog",
    priority: "medium",
    metadata: {
      source: "stack-updates-b",
      currentRelease: currentReleaseRaw,
      vendorTag: vendorTagRaw,
      vendorRepo: config.vendorRepo,
    },
  };

  const created = await issueSink.createDraftTask(payload);

  return {
    currentRelease: currentReleaseRaw,
    vendorTag: vendorTagRaw,
    diverged: true,
    draftTaskCreated: true,
    taskId: created.id,
    taskIdentifier: created.identifier,
    summary: description,
  };
}

/**
 * Release reconciliation service running periodic checks (e.g. daily).
 */
export class ReleaseReconciliationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly options: ReleaseReconciliationServiceOptions;

  constructor(options: ReleaseReconciliationServiceOptions = {}) {
    this.options = options;
  }

  async runOnce(): Promise<ReconcileResult> {
    return reconcileReleases(this.options);
  }

  start(): void {
    if (this.timer) return;

    const env = this.options.env ?? process.env;
    const config = readReleaseReconciliationConfig(env);
    const intervalSec = this.options.intervalSec ?? config.intervalSec;

    const intervalFn = this.options.timers?.setInterval ?? setInterval;

    const executeSweep = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const result = await this.runOnce();
        if (result.diverged && result.draftTaskCreated) {
          this.options.logger?.info(
            { taskId: result.taskId, vendorTag: result.vendorTag },
            "Release divergence detected, draft task created",
          );
        }
      } catch (err) {
        this.options.logger?.error({ err }, "Periodic release reconciliation failed");
      } finally {
        this.running = false;
      }
    };

    // Run immediately on start, then periodically
    void executeSweep();
    this.timer = intervalFn(executeSweep, intervalSec * 1000);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    const clearFn = this.options.timers?.clearInterval ?? clearInterval;
    clearFn(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
