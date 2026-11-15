// server/src/__tests__/intake-worker.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { intakeRoutes } from "../routes/intake.js";
import { createInMemoryIntakeQueue } from "../services/intake-queue.js";
import {
  getIntakeTemplate,
  parseWebhookDraft,
  DEFAULT_INTAKE_TEMPLATES,
  type IntakeSourceTemplate,
} from "../services/intake-templates.js";
import {
  IntakeWorker,
  createIntakeWorker,
  type IntakeWorkerIssueService,
} from "../services/intake-worker.js";

describe("Webhook Intake Source Templates (Data, not code)", () => {
  it("resolves default data templates for known sources", () => {
    const gh = getIntakeTemplate("github");
    expect(gh.source).toBe("github");
    expect(gh.titleTemplate).toContain("GitHub");

    const zbx = getIntakeTemplate("zabbix");
    expect(zbx.source).toBe("zabbix");
    expect(zbx.priorityField).toBe("severity");

    const generic = getIntakeTemplate("unknown-source");
    expect(generic.source).toBe("unknown-source");
    expect(generic.titleTemplate).toBe("{{title}}");
  });

  it("resolves custom data templates passed as data objects", () => {
    const customTemplates: Record<string, IntakeSourceTemplate> = {
      pagerduty: {
        source: "pagerduty",
        titleTemplate: "PD Incident: {{incident.title}}",
        defaultTitle: "PD Incident #{{incident.number}}",
        priority: "critical",
        casteKey: "oncall",
        maxRetries: 5,
      },
    };

    const template = getIntakeTemplate("pagerduty", customTemplates);
    expect(template.source).toBe("pagerduty");
    expect(template.maxRetries).toBe(5);

    const parsed = parseWebhookDraft(template, {
      incident: { title: "Database connection pool exhausted", number: 42 },
    });
    expect(parsed.title).toBe("PD Incident: Database connection pool exhausted");
    expect(parsed.priority).toBe("critical");
    expect(parsed.casteKey).toBe("oncall");
    expect(parsed.description).toContain("Database connection pool exhausted");
  });

  it("extracts mapped priority and caste correctly", () => {
    const zabbixTemplate = DEFAULT_INTAKE_TEMPLATES.zabbix;
    const parsed = parseWebhookDraft(zabbixTemplate, {
      event_name: "Disk partition /data is 95% full",
      severity: "disaster",
    });

    expect(parsed.title).toBe("Zabbix: Disk partition /data is 95% full");
    expect(parsed.priority).toBe("critical");
    expect(parsed.casteKey).toBe("engineering");
    expect(parsed.description).toContain("Disk partition /data is 95% full");
    expect(parsed.description).toContain("### Webhook Intake (zabbix)");
  });

  it("throws on unprocessable payload when missing title and no default exists", () => {
    const template: IntakeSourceTemplate = {
      source: "strict-source",
      titleTemplate: "{{non_existent_key}}",
      maxRetries: 3,
    };

    expect(() => parseWebhookDraft(template, { other: "data" })).toThrow(
      /unable to generate title/i,
    );
  });

  it("throws on missing required fields", () => {
    const template: IntakeSourceTemplate = {
      source: "required-source",
      titleTemplate: "Event: {{title}}",
      requiredFields: ["title", "account.id"],
      maxRetries: 3,
    };

    expect(() =>
      parseWebhookDraft(template, { title: "Hello" }),
    ).toThrow(/missing required field 'account\.id'/i);
  });
});

describe("IntakeWorker Background Parser", () => {
  let queue: ReturnType<typeof createInMemoryIntakeQueue>;
  let createdIssues: Array<{ companyId: string; data: any; id: string; identifier: string }>;
  let mockIssueService: IntakeWorkerIssueService;

  beforeEach(() => {
    queue = createInMemoryIntakeQueue();
    createdIssues = [];
    let issueCounter = 100;
    mockIssueService = {
      create: vi.fn(async (companyId, input) => {
        issueCounter++;
        const id = `issue-${issueCounter}`;
        const identifier = `OPE-${issueCounter}`;
        createdIssues.push({ companyId, data: input, id, identifier });
        return { id, identifier };
      }),
    };
  });

  it("processes a pending webhook draft into a task with title, priority, caste, and linked raw payload", async () => {
    const draft = await queue.enqueue({
      source: "zabbix",
      payload: {
        event_name: "High CPU utilization on host db-01",
        severity: "high",
      },
    });

    const worker = createIntakeWorker({
      queue,
      issueService: mockIssueService,
      companyId: "company-test-1",
    });

    const res = await worker.processItem(draft);
    expect(res.outcome).toBe("created");
    expect(res.issueId).toBeDefined();

    // Verify issue was created on the board
    expect(createdIssues).toHaveLength(1);
    const issue = createdIssues[0];
    expect(issue.companyId).toBe("company-test-1");
    expect(issue.data.title).toBe("Zabbix: High CPU utilization on host db-01");
    expect(issue.data.priority).toBe("high");
    expect(issue.data.casteKey).toBe("engineering");
    expect(issue.data.status).toBe("todo");
    // Verify raw payload is linked in description
    expect(issue.data.description).toContain("High CPU utilization on host db-01");
    expect(issue.data.description).toContain("Raw Payload");

    // Verify queue item is marked processed
    const updatedDraft = await queue.get(draft.id);
    expect(updatedDraft?.status).toBe("processed");
    expect(updatedDraft?.issueId).toBe(issue.id);
    expect(updatedDraft?.issueIdentifier).toBe(issue.identifier);
  });

  it("retries unprocessable payload until maxRetries limit and sets status to failed", async () => {
    const unprocessableDraft = await queue.enqueue({
      source: "strict-source",
      payload: { unparseable: true },
    });

    const customTemplates: Record<string, IntakeSourceTemplate> = {
      "strict-source": {
        source: "strict-source",
        titleTemplate: "{{title}}",
        maxRetries: 3,
      },
    };

    const worker = createIntakeWorker({
      queue,
      templates: customTemplates,
      issueService: mockIssueService,
      companyId: "company-test-1",
    });

    // Attempt 1: Should retry (retryCount = 1, status = pending)
    const outcome1 = await worker.processItem(unprocessableDraft);
    expect(outcome1.outcome).toBe("retry");
    if (outcome1.outcome === "retry") {
      expect(outcome1.retryCount).toBe(1);
    }
    let draftState = await queue.get(unprocessableDraft.id);
    expect(draftState?.status).toBe("pending");
    expect(draftState?.retryCount).toBe(1);
    expect(draftState?.lastError).toBeDefined();

    // Attempt 2: Should retry (retryCount = 2, status = pending)
    const outcome2 = await worker.processItem(draftState!);
    expect(outcome2.outcome).toBe("retry");
    if (outcome2.outcome === "retry") {
      expect(outcome2.retryCount).toBe(2);
    }
    draftState = await queue.get(unprocessableDraft.id);
    expect(draftState?.status).toBe("pending");
    expect(draftState?.retryCount).toBe(2);

    // Attempt 3: Limit reached (maxRetries = 3) -> should be failed
    const outcome3 = await worker.processItem(draftState!);
    expect(outcome3.outcome).toBe("failed");
    if (outcome3.outcome === "failed") {
      expect(outcome3.retryCount).toBe(3);
    }
    draftState = await queue.get(unprocessableDraft.id);
    expect(draftState?.status).toBe("failed");
    expect(draftState?.retryCount).toBe(3);
    expect(draftState?.lastError).toContain("marked as unparseable");

    // No issues created for the unprocessable draft
    expect(createdIssues).toHaveLength(0);
  });
});

describe("Integration Acceptance Test: Webhook -> Draft -> Created Task & Unprocessable Retry Limit", () => {
  let queue: ReturnType<typeof createInMemoryIntakeQueue>;
  let createdIssues: Array<{ companyId: string; data: any; id: string; identifier: string }>;
  let mockIssueService: IntakeWorkerIssueService;
  let app: express.Express;
  let worker: IntakeWorker;

  beforeEach(() => {
    queue = createInMemoryIntakeQueue();
    createdIssues = [];
    let counter = 200;

    mockIssueService = {
      create: vi.fn(async (companyId, input) => {
        counter++;
        const id = `issue-uuid-${counter}`;
        const identifier = `OPE-${counter}`;
        createdIssues.push({ companyId, data: input, id, identifier });
        return { id, identifier };
      }),
    };

    // myrmidon(1.6.8 INTAKE-AUTH): intake is closed by default on main — the
    // test app must explicitly configure the sources under test (github,
    // generic), exactly like the route tests in intake-route.test.ts.
    const intakeConfig = {
      enabled: true,
      sources: {
        github: {},
        generic: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };

    app = express();
    app.use(express.json());
    app.use(intakeRoutes({ queue, config: intakeConfig }));

    worker = createIntakeWorker({
      queue,
      issueService: mockIssueService,
      companyId: "company-intake-qa",
      maxRetriesDefault: 3,
    });
  });

  it("end-to-end: public intake receives webhook -> creates draft -> worker creates issue with title & links payload", async () => {
    const webhookPayload = {
      action: "opened",
      repository: { name: "myrmidon-core" },
      sender: { login: "octocat" },
    };

    // 1. Webhook hits intake route
    const postRes = await request(app)
      .post("/api/intake/github")
      .send(webhookPayload)
      .expect(202);

    expect(postRes.body.status).toBe("accepted");
    const intakeId = postRes.body.id;
    expect(intakeId).toBeDefined();

    // 2. Draft is in queue with status pending
    const draftBefore = await queue.get(intakeId);
    expect(draftBefore).not.toBeNull();
    expect(draftBefore?.status).toBe("pending");
    expect(draftBefore?.payload).toEqual(webhookPayload);

    // 3. Background worker runs
    const batchResult = await worker.processAllPending();
    expect(batchResult.processed).toBe(1);
    expect(batchResult.created).toBe(1);
    expect(batchResult.failed).toBe(0);

    // 4. Board issue created with filled title and linked raw payload
    expect(createdIssues).toHaveLength(1);
    const createdIssue = createdIssues[0];
    expect(createdIssue.companyId).toBe("company-intake-qa");
    expect(createdIssue.data.title).toBe("GitHub [myrmidon-core]: opened");
    expect(createdIssue.data.priority).toBe("medium");
    expect(createdIssue.data.casteKey).toBe("engineering");
    expect(createdIssue.data.description).toContain("myrmidon-core");
    expect(createdIssue.data.description).toContain("octocat");

    // 5. Webhook draft is marked processed and links the created issue
    const draftAfter = await queue.get(intakeId);
    expect(draftAfter?.status).toBe("processed");
    expect(draftAfter?.issueId).toBe(createdIssue.id);
    expect(draftAfter?.issueIdentifier).toBe(createdIssue.identifier);
  });

  it("end-to-end: unprocessable payload fails after reaching retry limit", async () => {
    // Post unprocessable payload with empty/missing title and unparseable data
    const postRes = await request(app)
      .post("/api/intake/generic")
      .send({ unparseable: true, title: "" })
      .expect(202);

    const intakeId = postRes.body.id;

    // Run worker for retry attempt 1
    let res = await worker.processAllPending();
    expect(res.retried).toBe(1);
    let item = await queue.get(intakeId);
    expect(item?.status).toBe("pending");
    expect(item?.retryCount).toBe(1);

    // Run worker for retry attempt 2
    res = await worker.processAllPending();
    expect(res.retried).toBe(1);
    item = await queue.get(intakeId);
    expect(item?.status).toBe("pending");
    expect(item?.retryCount).toBe(2);

    // Run worker for retry attempt 3 (reaches maxRetries = 3)
    res = await worker.processAllPending();
    expect(res.failed).toBe(1);
    item = await queue.get(intakeId);
    expect(item?.status).toBe("failed");
    expect(item?.retryCount).toBe(3);
    expect(item?.lastError).toBeDefined();

    // Board has no issues created for this failed intake
    expect(createdIssues).toHaveLength(0);
  });
});
