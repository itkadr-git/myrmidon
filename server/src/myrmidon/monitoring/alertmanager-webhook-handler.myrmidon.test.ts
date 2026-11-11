// server/src/myrmidon/monitoring/alertmanager-webhook-handler.myrmidon.test.ts
// Unit tests for Alertmanager resolved webhook handler (OPE-12085)

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  handleAlertmanagerWebhook,
  createAlertmanagerWebhookRouteHandler,
  createAlertmanagerWebhookRouter,
  adaptAlertDedupStore,
  extractAlertmanagerAlertDetails,
  renderAlertmanagerAutoCloseComment,
  type AlertmanagerWebhookPayload,
  type AlertmanagerWebhookHandlerDeps,
  type AlertmanagerIssuePorts,
  type AlertmanagerTaskFinder,
  type AlertmanagerOpenTask,
} from "./alertmanager-webhook-handler.js";
import type { AlertDedupStore, DedupEntry } from "./alerts/store.js";

function createMockIssuePorts(): {
  ports: AlertmanagerIssuePorts;
  comments: Array<{ issueId: string; body: string }>;
  statuses: Array<{ issueId: string; status: string }>;
} {
  const comments: Array<{ issueId: string; body: string }> = [];
  const statuses: Array<{ issueId: string; status: string }> = [];

  const ports: AlertmanagerIssuePorts = {
    async addComment(issueId: string, body: string) {
      comments.push({ issueId, body });
      return Promise.resolve();
    },
    async updateStatus(issueId: string, status: string) {
      statuses.push({ issueId, status });
      return Promise.resolve();
    },
  };

  return { ports, comments, statuses };
}

describe("Alertmanager Webhook Handler (OPE-12085)", () => {
  const companyId = "2870b911-483a-4091-9f15-183841811143";

  describe("extractAlertmanagerAlertDetails", () => {
    it("extracts fingerprint, alertname, and resolved flag correctly", () => {
      const payload: AlertmanagerWebhookPayload = {
        status: "resolved",
        commonLabels: { alertname: "DiskSpaceLow" },
        alerts: [
          {
            status: "resolved",
            fingerprint: "fp-disk-001",
            labels: { alertname: "DiskSpaceLow", instance: "srv1" },
            endsAt: "2026-11-07T12:00:00Z",
          },
        ],
      };

      const extracted = extractAlertmanagerAlertDetails(payload.alerts![0]!, payload);
      expect(extracted.fingerprint).toBe("fp-disk-001");
      expect(extracted.alertname).toBe("DiskSpaceLow");
      expect(extracted.isResolved).toBe(true);
      expect(extracted.resolvedAt).toBe("2026-11-07T12:00:00Z");
    });

    it("falls back to payload status and labels when alert lacks them", () => {
      const payload: AlertmanagerWebhookPayload = {
        status: "resolved",
        commonLabels: { alert_name: "MemoryExhaustion" },
      };

      const extracted = extractAlertmanagerAlertDetails({}, payload);
      expect(extracted.alertname).toBe("MemoryExhaustion");
      expect(extracted.isResolved).toBe(true);
      expect(extracted.fingerprint).toBeNull();
    });
  });

  describe("renderAlertmanagerAutoCloseComment", () => {
    it("formats recovery comment with alertname and timestamp", () => {
      const text = renderAlertmanagerAutoCloseComment({
        alertname: "ServiceDegraded",
        fingerprint: "fp-123",
        resolvedAt: "2026-11-07T10:15:30.000Z",
      });
      expect(text).toContain("Recovered: the alertmanager alert ServiceDegraded (fp-123)");
      expect(text).toContain("2026-11-07T10:15:30.000Z");
      expect(text).toContain("Closing automatically.");
    });
  });

  describe("handleAlertmanagerWebhook", () => {
    it("finds open task by fingerprint and transitions status to done with auto-close comment", async () => {
      const { ports, comments, statuses } = createMockIssuePorts();
      const markResolvedSpy = vi.fn().mockResolvedValue(undefined);

      const openTask: AlertmanagerOpenTask = {
        issueId: "issue-abc-123",
        issueIdentifier: "OPE-9999",
        status: "open",
        fingerprint: "fp-mem-42",
        alertname: "HighMemoryUsage",
      };

      const finder: AlertmanagerTaskFinder = {
        async findOpenTask(_companyId, criteria) {
          if (criteria.fingerprint === "fp-mem-42") {
            return openTask;
          }
          return null;
        },
        markResolved: markResolvedSpy,
      };

      const deps: AlertmanagerWebhookHandlerDeps = {
        companyId,
        issues: ports,
        finder,
        now: () => new Date("2026-11-07T12:30:00.000Z"),
      };

      const payload: AlertmanagerWebhookPayload = {
        version: "4",
        status: "resolved",
        alerts: [
          {
            status: "resolved",
            fingerprint: "fp-mem-42",
            labels: { alertname: "HighMemoryUsage" },
            endsAt: "2026-11-07T12:29:55.000Z",
          },
        ],
      };

      const result = await handleAlertmanagerWebhook(payload, deps);

      expect(result.status).toBe("ok");
      expect(result.processed).toBe(1);
      expect(result.results[0]!).toMatchObject({
        fingerprint: "fp-mem-42",
        alertname: "HighMemoryUsage",
        action: "resolve",
        issueId: "issue-abc-123",
        issueIdentifier: "OPE-9999",
        status: "done",
      });

      // Verify task status was updated to done
      expect(statuses).toEqual([{ issueId: "issue-abc-123", status: "done" }]);

      // Verify comment was posted
      expect(comments.length).toBe(1);
      expect(comments[0]!.issueId).toBe("issue-abc-123");
      expect(comments[0]!.body).toContain("Recovered: the alertmanager alert HighMemoryUsage (fp-mem-42)");
      expect(comments[0]!.body).toContain("Closing automatically.");

      // Verify markResolved was called
      expect(markResolvedSpy).toHaveBeenCalledWith(
        companyId,
        {
          fingerprint: "fp-mem-42",
          alertname: "HighMemoryUsage",
          issueId: "issue-abc-123",
        },
        "2026-11-07T12:29:55.000Z",
      );
    });

    it("acts as a no-op when no open task exists (returns 200-ready noop)", async () => {
      const { ports, comments, statuses } = createMockIssuePorts();
      const markResolvedSpy = vi.fn();

      const finder: AlertmanagerTaskFinder = {
        async findOpenTask() {
          return null; // No task found
        },
        markResolved: markResolvedSpy,
      };

      const deps: AlertmanagerWebhookHandlerDeps = {
        companyId,
        issues: ports,
        finder,
      };

      const payload: AlertmanagerWebhookPayload = {
        version: "4",
        status: "resolved",
        alerts: [
          {
            status: "resolved",
            fingerprint: "fp-unknown-999",
            labels: { alertname: "UnknownAlert" },
          },
        ],
      };

      const result = await handleAlertmanagerWebhook(payload, deps);

      expect(result.status).toBe("ok");
      expect(result.processed).toBe(1);
      expect(result.results[0]!).toMatchObject({
        fingerprint: "fp-unknown-999",
        alertname: "UnknownAlert",
        action: "noop",
        issueId: null,
        status: "ignored",
      });

      // No comments added and no status changes
      expect(comments.length).toBe(0);
      expect(statuses.length).toBe(0);
      expect(markResolvedSpy).not.toHaveBeenCalled();
    });

    it("falls back to finding open task by alertname when fingerprint does not match", async () => {
      const { ports, comments, statuses } = createMockIssuePorts();

      const openTask: AlertmanagerOpenTask = {
        issueId: "issue-by-name-555",
        issueIdentifier: "OPE-5555",
        status: "open",
        fingerprint: null,
        alertname: "KubeNodeNotReady",
      };

      const finder: AlertmanagerTaskFinder = {
        async findOpenTask(_companyId, criteria) {
          if (criteria.fingerprint === "fp-different-hash") {
            return null;
          }
          if (criteria.alertname === "KubeNodeNotReady") {
            return openTask;
          }
          return null;
        },
      };

      const deps: AlertmanagerWebhookHandlerDeps = {
        companyId,
        issues: ports,
        finder,
      };

      const payload: AlertmanagerWebhookPayload = {
        status: "resolved",
        alerts: [
          {
            status: "resolved",
            fingerprint: "fp-different-hash",
            labels: { alertname: "KubeNodeNotReady" },
          },
        ],
      };

      const result = await handleAlertmanagerWebhook(payload, deps);

      expect(result.status).toBe("ok");
      expect(result.results[0]!).toMatchObject({
        action: "resolve",
        issueId: "issue-by-name-555",
        status: "done",
      });
      expect(statuses).toEqual([{ issueId: "issue-by-name-555", status: "done" }]);
      expect(comments.length).toBe(1);
    });

    it("ignores non-resolved (firing) alerts gracefully", async () => {
      const { ports, comments, statuses } = createMockIssuePorts();
      const finder: AlertmanagerTaskFinder = {
        findOpenTask: vi.fn(),
      };

      const deps: AlertmanagerWebhookHandlerDeps = {
        companyId,
        issues: ports,
        finder,
      };

      const payload: AlertmanagerWebhookPayload = {
        status: "firing",
        alerts: [
          {
            status: "firing",
            fingerprint: "fp-firing-1",
            labels: { alertname: "CpuLoadHigh" },
          },
        ],
      };

      const result = await handleAlertmanagerWebhook(payload, deps);
      expect(result.status).toBe("ok");
      expect(result.results[0]!.action).toBe("noop");
      expect(comments.length).toBe(0);
      expect(statuses.length).toBe(0);
      expect(finder.findOpenTask).not.toHaveBeenCalled();
    });
  });

  describe("adaptAlertDedupStore", () => {
    it("looks up by fingerprint and marks resolved on the underlying store", async () => {
      const dummyEntry: DedupEntry = {
        id: "alertmanager:fp-dedup-01",
        companyId,
        issueId: "issue-dedup-77",
        issueIdentifier: "OPE-777",
        issueStatus: "open",
        createdAt: "2026-11-07T00:00:00Z",
        updatedAt: "2026-11-07T00:00:00Z",
        resolvedAt: null,
      };

      const store: AlertDedupStore = {
        async get(cId, source, key) {
          if (cId === companyId && source === "alertmanager" && key === "fp-dedup-01") {
            return dummyEntry;
          }
          return null;
        },
        upsert: vi.fn(),
        markResolved: vi.fn().mockResolvedValue(dummyEntry),
        sweepClosedOlderThan: vi.fn().mockResolvedValue(0),
        async findOpen(_cId, _source, criteria) {
          if (criteria.fingerprint === "fp-dedup-01") {
            return dummyEntry;
          }
          return null;
        },
      };

      const finder = adaptAlertDedupStore(store);

      const found = await finder.findOpenTask(companyId, { fingerprint: "fp-dedup-01" });
      expect(found).toMatchObject({
        issueId: "issue-dedup-77",
        issueIdentifier: "OPE-777",
        status: "open",
        fingerprint: "fp-dedup-01",
      });

      await finder.markResolved!(
        companyId,
        { fingerprint: "fp-dedup-01", issueId: "issue-dedup-77" },
        "2026-11-07T12:00:00Z",
      );
      expect(store.markResolved).toHaveBeenCalledWith(
        companyId,
        "alertmanager",
        "fp-dedup-01",
        "2026-11-07T12:00:00Z",
      );
    });
  });

  describe("HTTP route & router (createAlertmanagerWebhookRouteHandler)", () => {
    it("returns HTTP 200 with result payload for resolved alert", async () => {
      const { ports } = createMockIssuePorts();
      const finder: AlertmanagerTaskFinder = {
        async findOpenTask(_cId, criteria) {
          if (criteria.fingerprint === "fp-route-test") {
            return {
              issueId: "issue-http-1",
              issueIdentifier: "OPE-1111",
              status: "open",
            };
          }
          return null;
        },
      };

      const handler = createAlertmanagerWebhookRouteHandler({
        companyId,
        issues: ports,
        finder,
      });

      let statusCode = 0;
      let jsonBody: unknown = null;

      const req = {
        body: {
          status: "resolved",
          alerts: [
            {
              status: "resolved",
              fingerprint: "fp-route-test",
              labels: { alertname: "DiskFull" },
            },
          ],
        },
      } as unknown as Request;

      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: unknown) {
          jsonBody = data;
          return this;
        },
      } as unknown as Response;

      await handler(req, res);

      expect(statusCode).toBe(200);
      expect(jsonBody).toMatchObject({
        status: "ok",
        processed: 1,
        results: [
          {
            action: "resolve",
            issueId: "issue-http-1",
            status: "done",
          },
        ],
      });
    });

    it("returns HTTP 200 for no-op payload when no matching task exists", async () => {
      const { ports } = createMockIssuePorts();
      const finder: AlertmanagerTaskFinder = {
        async findOpenTask() {
          return null;
        },
      };

      const router = createAlertmanagerWebhookRouter({
        companyId,
        issues: ports,
        finder,
      });
      expect(router).toBeDefined();

      const handler = createAlertmanagerWebhookRouteHandler({
        companyId,
        issues: ports,
        finder,
      });

      let statusCode = 0;
      let jsonBody: unknown = null;

      const req = {
        body: {
          status: "resolved",
          alerts: [{ status: "resolved", fingerprint: "fp-missing" }],
        },
      } as unknown as Request;

      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: unknown) {
          jsonBody = data;
          return this;
        },
      } as unknown as Response;

      await handler(req, res);

      expect(statusCode).toBe(200);
      expect(jsonBody).toMatchObject({
        status: "ok",
        processed: 1,
        results: [
          {
            action: "noop",
            issueId: null,
            status: "ignored",
          },
        ],
      });
    });
  });
});
