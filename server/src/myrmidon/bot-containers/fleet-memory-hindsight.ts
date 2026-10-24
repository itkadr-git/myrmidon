// server/src/myrmidon/bot-containers/fleet-memory-hindsight.ts
//
// myrmidon(1.6.6 C-MEM): the board's side of the memory sync talking to its own hindsight: it
// merges a transfer archive (the export of a site's bank) into the replica bank.
//
// POST /v1/default/banks/{bank}/transfer/import?mode=merge&document_conflict=skip, a multipart
// upload that answers an operation_id; the operation is polled until it completes. `skip` is what
// keeps a repeated or resumed sync from duplicating documents. The transport is injectable so
// tests never reach a real service.

import type { FetchLike } from "../agent-memory/hindsight-client.js";

export const FLEET_MEMORY_HINDSIGHT_URL_ENV = "MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL";
export const FLEET_MEMORY_HINDSIGHT_TOKEN_ENV = "MYRMIDON_FLEET_MEMORY_HINDSIGHT_TOKEN";
export const FLEET_MEMORY_REPLICA_BANK_ENV = "MYRMIDON_FLEET_MEMORY_REPLICA_BANK";

export interface FleetMemoryImporterConfig {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
  /** Per HTTP request. */
  requestTimeoutMs?: number;
  /** For the whole import operation. */
  operationTimeoutMs?: number;
  pollMs?: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createFleetMemoryImporter(config: FleetMemoryImporterConfig) {
  const base = config.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init));
  const requestTimeoutMs = config.requestTimeoutMs ?? 60_000;
  const operationTimeoutMs = config.operationTimeoutMs ?? 10 * 60_000;
  const pollMs = config.pollMs ?? 1_000;

  function headers(): Record<string, string> {
    return config.token ? { Authorization: `Bearer ${config.token}`, Accept: "application/json" } : { Accept: "application/json" };
  }

  async function json(url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!res.ok) throw new Error(`${what} answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new Error(`${what} answered a body that is not JSON`);
    return body;
  }

  return async function importArchive(bank: string, archive: Buffer): Promise<{ imported: number | null; skipped: number | null }> {
    const bankPath = `${base}/v1/default/banks/${encodeURIComponent(bank)}`;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(archive)], { type: "application/zip" }), "memory-export.zip");
    const submitted = await json(
      `${bankPath}/transfer/import?mode=merge&document_conflict=skip`,
      { method: "POST", headers: headers(), body: form },
      "memory import",
    );
    const operationId = typeof submitted.operation_id === "string" ? submitted.operation_id : "";
    if (!operationId) throw new Error("memory import answered no operation_id");

    const deadline = Date.now() + operationTimeoutMs;
    for (;;) {
      const status = await json(`${bankPath}/operations/${encodeURIComponent(operationId)}`, { method: "GET", headers: headers() }, "memory import status");
      switch (status.status) {
        case "completed": {
          const meta = (status.result_metadata ?? {}) as Record<string, unknown>;
          return { imported: count(meta.documents_imported), skipped: count(meta.documents_skipped) };
        }
        case "failed":
        case "cancelled":
        case "not_found":
          throw new Error(`memory import operation ${String(status.status)}: ${String(status.error_message ?? "no message")}`);
        default:
          if (Date.now() >= deadline) throw new Error("memory import operation timed out");
          await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  };
}

/** The importer named by MYRMIDON_FLEET_MEMORY_HINDSIGHT_URL, or null when the variable is not set. */
export function fleetMemoryImporterFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = env[FLEET_MEMORY_HINDSIGHT_URL_ENV]?.trim();
  if (!baseUrl) return null;
  return createFleetMemoryImporter({ baseUrl, token: env[FLEET_MEMORY_HINDSIGHT_TOKEN_ENV]?.trim() || undefined });
}
