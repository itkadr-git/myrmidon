// server/src/services/intake-worker.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Background worker for parsing webhook drafts into board issues.
// Takes drafts from IntakeQueue, parses them according to source data templates (title, priority, caste),
// creates an issue with linked raw payload, marks draft as processed, and retries with limit before status=failed.

import type { Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import {
  type IntakeQueue,
  type IntakeQueueItem,
  defaultIntakeQueue,
} from "./intake-queue.js";
import {
  type IntakeSourceTemplate,
  getIntakeTemplate,
  parseWebhookDraft,
} from "./intake-templates.js";

export interface IntakeWorkerIssueService {
  create(
    companyId: string,
    input: {
      title: string;
      description?: string | null;
      priority?: "low" | "medium" | "high" | "critical";
      casteKey?: string | null;
      status?: string;
    },
  ): Promise<{ id: string; identifier?: string | null }>;
}

export interface IntakeWorkerOptions {
  queue?: IntakeQueue;
  issueService?: IntakeWorkerIssueService;
  templates?: Record<string, IntakeSourceTemplate> | IntakeSourceTemplate[];
  companyId?: string | (() => Promise<string | null> | string | null);
  db?: Db;
  logger?: Pick<typeof logger, "info" | "warn" | "error" | "debug">;
  pollIntervalMs?: number;
  maxRetriesDefault?: number;
  env?: NodeJS.ProcessEnv;
}

export type ProcessItemOutcome =
  | { outcome: "created"; issueId: string; issueIdentifier?: string | null }
  | { outcome: "retry"; error: string; retryCount: number }
  | { outcome: "failed"; error: string; retryCount: number }
  | { outcome: "skipped"; reason: string };

export class IntakeWorker {
  private readonly queue: IntakeQueue;
  private readonly issueService?: IntakeWorkerIssueService;
  private readonly templates?: Record<string, IntakeSourceTemplate> | IntakeSourceTemplate[];
  private readonly companyIdResolver?: string | (() => Promise<string | null> | string | null);
  private readonly db?: Db;
  private readonly log: Pick<typeof logger, "info" | "warn" | "error" | "debug">;
  private readonly pollIntervalMs: number;
  private readonly maxRetriesDefault: number;
  private readonly env: NodeJS.ProcessEnv;
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: IntakeWorkerOptions = {}) {
    this.queue = options.queue ?? defaultIntakeQueue;
    this.templates = options.templates;
    this.companyIdResolver = options.companyId;
    this.db = options.db;
    this.log = options.logger ?? logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxRetriesDefault = options.maxRetriesDefault ?? 3;
    this.env = options.env ?? process.env;

    if (options.issueService) {
      this.issueService = options.issueService;
    } else if (options.db) {
      const svc = issueService(options.db);
      this.issueService = {
        async create(companyId, input) {
          const created = await svc.create(companyId, {
            title: input.title,
            description: input.description,
            priority: input.priority,
            casteKey: input.casteKey,
            status: input.status ?? "todo",
          });
          return { id: created.id, identifier: created.identifier ?? null };
        },
      };
    }
  }

  async resolveCompanyId(): Promise<string> {
    if (typeof this.companyIdResolver === "function") {
      const id = await this.companyIdResolver();
      if (id) return id;
    } else if (typeof this.companyIdResolver === "string" && this.companyIdResolver.trim()) {
      return this.companyIdResolver.trim();
    }

    const envCompanyId =
      this.env.MYRMIDON_INTAKE_COMPANY_ID?.trim() ||
      this.env.MYRMIDON_ALERTS_COMPANY_ID?.trim();
    if (envCompanyId) return envCompanyId;

    if (this.db) {
      const firstCompany = await this.db.query.companies.findFirst();
      if (firstCompany?.id) return firstCompany.id;
    }

    return "default-company";
  }

  async processItem(item: IntakeQueueItem): Promise<ProcessItemOutcome> {
    if (item.status !== "pending") {
      return { outcome: "skipped", reason: `Item status is ${item.status}` };
    }

    // Mark as processing
    await this.queue.updateStatus(item.id, "processing");

    const template = getIntakeTemplate(item.source, this.templates, this.env);
    const maxRetries = template.maxRetries ?? this.maxRetriesDefault;

    try {
      // 1. Parse draft by template
      const parsed = parseWebhookDraft(template, item.payload, item.rawBody);

      // 2. Resolve company and create issue
      if (!this.issueService) {
        throw new Error("No issue service configured for intake worker");
      }
      const companyId = await this.resolveCompanyId();
      const issue = await this.issueService.create(companyId, {
        title: parsed.title,
        description: parsed.description,
        priority: parsed.priority,
        casteKey: parsed.casteKey,
        status: "todo",
      });

      // 3. Mark processed and link issueId
      await this.queue.updateStatus(item.id, "processed", {
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
      });

      this.log.info(
        { intakeId: item.id, source: item.source, issueId: issue.id, issueIdentifier: issue.identifier },
        "webhook draft successfully parsed into issue",
      );

      return {
        outcome: "created",
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
      };
    } catch (err: any) {
      const retryCount = (item.retryCount ?? 0) + 1;
      const errorMessage = err?.message || String(err);

      if (retryCount >= maxRetries) {
        // Limit exceeded -> failed
        await this.queue.updateStatus(item.id, "failed", {
          retryCount,
          lastError: errorMessage,
        });

        this.log.error(
          { intakeId: item.id, source: item.source, retryCount, maxRetries, error: errorMessage },
          "webhook draft parsing failed after reaching max retries",
        );

        return { outcome: "failed", error: errorMessage, retryCount };
      } else {
        // Under limit -> retry later (status back to pending)
        await this.queue.updateStatus(item.id, "pending", {
          retryCount,
          lastError: errorMessage,
        });

        this.log.warn(
          { intakeId: item.id, source: item.source, retryCount, maxRetries, error: errorMessage },
          "webhook draft parsing error, scheduled for retry",
        );

        return { outcome: "retry", error: errorMessage, retryCount };
      }
    }
  }

  async processAllPending(): Promise<{
    processed: number;
    created: number;
    retried: number;
    failed: number;
  }> {
    if (this.isProcessing) {
      return { processed: 0, created: 0, retried: 0, failed: 0 };
    }

    this.isProcessing = true;
    let created = 0;
    let retried = 0;
    let failed = 0;

    try {
      const pendingItems = await this.queue.list({ status: "pending" });
      for (const item of pendingItems) {
        const result = await this.processItem(item);
        if (result.outcome === "created") created++;
        else if (result.outcome === "retry") retried++;
        else if (result.outcome === "failed") failed++;
      }
      return {
        processed: pendingItems.length,
        created,
        retried,
        failed,
      };
    } finally {
      this.isProcessing = false;
    }
  }

  start(): () => void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      void this.processAllPending().catch((err) => {
        this.log.error({ err }, "error during intake worker loop");
      });
    }, this.pollIntervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function createIntakeWorker(options?: IntakeWorkerOptions): IntakeWorker {
  return new IntakeWorker(options);
}

let globalWorkerStop: (() => void) | null = null;

export function startIntakeWorker(db: Db, options?: IntakeWorkerOptions): () => void {
  if (globalWorkerStop) {
    globalWorkerStop();
    globalWorkerStop = null;
  }

  const worker = createIntakeWorker({ db, ...options });
  const stop = worker.start();
  globalWorkerStop = stop;
  return stop;
}

export function stopIntakeWorker(): void {
  if (globalWorkerStop) {
    globalWorkerStop();
    globalWorkerStop = null;
  }
}
