// myrmidon(PLUGIN-INSTANCE-ADMIN): an action handler sees the host-verified
// instance-admin flag of the board user, and only a literal `true` counts.
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { createRequest, isJsonRpcResponse, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { createTestHarness } from "../src/testing.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const manifest = {
  id: "example.instance-admin",
  apiVersion: 1 as const,
  version: "1.0.0",
  displayName: "Instance admin probe",
  description: "Test plugin",
  author: "Example",
  categories: ["automation" as const],
  capabilities: [],
  entrypoints: {},
};

async function actorSeenByWorker(actorContext: unknown): Promise<Record<string, unknown>> {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  let nextId = 1;
  const plugin = definePlugin({
    async setup(ctx) {
      ctx.actions.register("whoami", async (_params, context) => ({ actor: context.actor }));
    },
  });
  const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });
  const call = (method: string, params: unknown) => {
    const id = `host-${nextId++}`;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) reject(new Error(response.error.message));
        else resolve((response as { result?: unknown }).result);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  };
  hostReadline.on("line", (line) => {
    const message = parseMessage(line);
    if (!isJsonRpcResponse(message)) return;
    pending.get(String(message.id))?.(message);
    pending.delete(String(message.id));
  });
  try {
    await call("initialize", { manifest, config: {}, databaseNamespace: null });
    const result = (await call("performAction", { key: "whoami", params: {}, actorContext })) as {
      actor: Record<string, unknown>;
    };
    return result.actor;
  } finally {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }
}

const user = { type: "user", userId: "user-a", agentId: null, runId: null, companyId: null };

describe("action context: isInstanceAdmin", () => {
  it("carries the host flag to the action handler", async () => {
    expect(await actorSeenByWorker({ ...user, isInstanceAdmin: true })).toMatchObject({
      type: "user",
      userId: "user-a",
      isInstanceAdmin: true,
    });
  });

  it("is false when the host does not say true", async () => {
    expect((await actorSeenByWorker(user)).isInstanceAdmin).toBe(false);
    expect((await actorSeenByWorker({ ...user, isInstanceAdmin: "true" })).isInstanceAdmin).toBe(false);
    expect((await actorSeenByWorker(null)).isInstanceAdmin).toBe(false);
  });

  it("is available in the test harness for plugin authors", async () => {
    const harness = createTestHarness({ manifest });
    harness.ctx.actions.register("whoami", async (_params, context) => ({ admin: context.actor.isInstanceAdmin }));
    await expect(
      harness.performAction("whoami", {}, { actor: { type: "user", userId: "user-a", isInstanceAdmin: true } }),
    ).resolves.toEqual({ admin: true });
    await expect(harness.performAction("whoami", {}, { actor: { type: "user", userId: "user-a" } })).resolves.toEqual({
      admin: false,
    });
  });
});
