// server/src/myrmidon/bot-containers/fleet-memory-hindsight.myrmidon.test.ts

import { describe, expect, it } from "vitest";
import { createFleetMemoryImporter, fleetMemoryImporterFromEnv } from "./fleet-memory-hindsight.js";

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fleet memory importer", () => {
  it("uploads the archive in merge mode with skip on conflicts and polls the operation to its counts", async () => {
    const calls: Array<{ method: string; url: string; auth: string | null; file: unknown }> = [];
    let polls = 0;
    const importArchive = createFleetMemoryImporter({
      baseUrl: "http://hindsight.test:8890/",
      token: "t0ken",
      pollMs: 1,
      fetchImpl: async (url, init) => {
        const form = init?.body instanceof FormData ? init.body.get("file") : null;
        calls.push({ method: String(init?.method), url, auth: new Headers(init?.headers).get("Authorization"), file: form instanceof Blob ? form.size : null });
        if (init?.method === "POST") return reply({ operation_id: "op 1", status: "pending" });
        polls += 1;
        return polls < 2
          ? reply({ operation_id: "op 1", status: "processing" })
          : reply({ operation_id: "op 1", status: "completed", result_metadata: { documents_imported: 3, documents_skipped: 4 } });
      },
    });

    const counts = await importArchive("fleet-work-replica", Buffer.from("zip-bytes"));

    expect(counts).toEqual({ imported: 3, skipped: 4 });
    expect(calls[0]).toEqual({
      method: "POST",
      url: "http://hindsight.test:8890/v1/default/banks/fleet-work-replica/transfer/import?mode=merge&document_conflict=skip",
      auth: "Bearer t0ken",
      file: 9,
    });
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      "http://hindsight.test:8890/v1/default/banks/fleet-work-replica/operations/op%201",
      "http://hindsight.test:8890/v1/default/banks/fleet-work-replica/operations/op%201",
    ]);
  });

  it("gives null counts when the service reports none", async () => {
    const importArchive = createFleetMemoryImporter({
      baseUrl: "http://h",
      pollMs: 1,
      fetchImpl: async (_url, init) => (init?.method === "POST" ? reply({ operation_id: "o" }) : reply({ status: "completed" })),
    });
    expect(await importArchive("b", Buffer.from("x"))).toEqual({ imported: null, skipped: null });
  });

  it("rejects on a refused upload, a failed operation and a timeout", async () => {
    const refused = createFleetMemoryImporter({ baseUrl: "http://h", fetchImpl: async () => reply({}, 503) });
    await expect(refused("b", Buffer.from("x"))).rejects.toThrow("memory import answered HTTP 503");

    const noOperation = createFleetMemoryImporter({ baseUrl: "http://h", fetchImpl: async () => reply({}) });
    await expect(noOperation("b", Buffer.from("x"))).rejects.toThrow("no operation_id");

    const failed = createFleetMemoryImporter({
      baseUrl: "http://h",
      pollMs: 1,
      fetchImpl: async (_url, init) => (init?.method === "POST" ? reply({ operation_id: "o" }) : reply({ status: "failed", error_message: "bad archive" })),
    });
    await expect(failed("b", Buffer.from("x"))).rejects.toThrow("memory import operation failed: bad archive");

    const stuck = createFleetMemoryImporter({
      baseUrl: "http://h",
      pollMs: 1,
      operationTimeoutMs: 20,
      fetchImpl: async (_url, init) => (init?.method === "POST" ? reply({ operation_id: "o" }) : reply({ status: "processing" })),
    });
    await expect(stuck("b", Buffer.from("x"))).rejects.toThrow("timed out");
  });

  it("is absent without MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL", () => {
    expect(fleetMemoryImporterFromEnv({})).toBeNull();
    expect(fleetMemoryImporterFromEnv({ MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL: "http://h:8890" })).toBeTypeOf("function");
  });
});
