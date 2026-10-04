// myrmidon(PLS2) sentinel: an un-echoed worker→host call made from inside a
// bridge entry point (getData / performAction / executeTool) must be
// attributed to the company of the in-flight invocation, not denied.
// The fixture worker simulates a plugin bundle built with an SDK that
// predates invocation-id echo (mode "omit").
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "__tests__",
  "fixtures",
);
const BRIDGE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-invocation-scope-bridge.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function makeBridgeHandle(companiesGet: unknown) {
  const hostHandlers = createHostClientHandlers({
    pluginId: "test.plugin",
    capabilities: ["companies.read"],
    services: {
      companies: {
        get: companiesGet,
      },
    } as unknown as HostServices,
  });
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: BRIDGE_WORKER_ENTRYPOINT,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
    },
    apiVersion: 1,
    hostHandlers,
  });
}

describe("plugin invocation scope bridge (PLS2)", () => {
  it("attributes an un-echoed nested call from getData to the in-flight company", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = makeBridgeHandle(companiesGet);

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-a",
        params: {
          mode: "omit",
          requestedCompanyId: "company-a",
        },
      } as HostToWorkerMethods["getData"][0])).resolves.toMatchObject({
        id: "company-a",
      });
      // A wrong or missing attribution makes the SDK gate throw
      // INVOCATION_SCOPE_DENIED before the service runs, so a resolved call
      // with the in-flight company proves the scope was attached.
      expect(companiesGet).toHaveBeenCalledWith({ companyId: "company-a" });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("attributes an un-echoed nested call from performAction to the in-flight company", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = makeBridgeHandle(companiesGet);

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "omit",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).resolves.toMatchObject({
        id: "company-a",
      });
      expect(companiesGet).toHaveBeenCalledWith({ companyId: "company-a" });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("attributes an un-echoed nested call from executeTool to the in-flight company", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = makeBridgeHandle(companiesGet);

    try {
      await handle.start();

      await expect(handle.call("executeTool", {
        toolName: "probe",
        parameters: {
          mode: "omit",
          requestedCompanyId: "company-a",
        },
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
          projectId: "project-1",
        },
      })).resolves.toMatchObject({
        id: "company-a",
      });
      expect(companiesGet).toHaveBeenCalledWith({ companyId: "company-a" });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still denies an un-echoed nested call that requests another company", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({
      id: params.companyId,
    }));
    const handle = makeBridgeHandle(companiesGet);

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "omit",
          requestedCompanyId: "company-b",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
