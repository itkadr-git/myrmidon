import { describe, expect, it, vi } from "vitest";
import {
  AdmConnectorError,
  createAdmKnowledgeAdapter,
  type AdmConnectorCode,
  type AdmKnowledgeRestPort,
} from "./adm-knowledge-adapter.js";

const marker = "synthetic-upstream-message-marker";
const statuses: Array<[number, AdmConnectorCode]> = [
  [401, "ADM_UNAUTHORIZED"],
  [403, "ADM_FORBIDDEN"],
  [404, "ADM_NOT_FOUND"],
  [409, "ADM_REVISION_CONFLICT"],
  [429, "ADM_RATE_LIMITED"],
  [500, "ADM_UPSTREAM_UNAVAILABLE"],
];

const cases: Array<{ label: string; rejection: unknown; code: AdmConnectorCode }> = [
  ...statuses.flatMap(([status, code]) => [
    { label: `numeric status ${status}`, rejection: { status, message: marker }, code },
    { label: `string status ${status}`, rejection: { status: String(status), message: marker }, code },
  ]),
  { label: "unknown object", rejection: { message: marker }, code: "ADM_UPSTREAM_UNAVAILABLE" },
  { label: "Error without status", rejection: new Error(marker), code: "ADM_UPSTREAM_UNAVAILABLE" },
  { label: "null", rejection: null, code: "ADM_UPSTREAM_UNAVAILABLE" },
  { label: "undefined", rejection: undefined, code: "ADM_UPSTREAM_UNAVAILABLE" },
  { label: "approval marker without status", rejection: { message: `knowledge_rule_approve_forbidden ${marker}` }, code: "ADM_FORBIDDEN" },
  { label: "401 precedes approval marker", rejection: { status: 401, message: `knowledge_rule_approve_forbidden ${marker}` }, code: "ADM_UNAUTHORIZED" },
];

describe("ADM knowledge REST error surface", () => {
  for (const operation of ["read", "list", "search"] as const) {
    for (const { label, rejection, code } of cases) {
      it(`${operation}: maps ${label} without leaking the upstream message`, async () => {
        const fail = vi.fn(async () => { throw rejection; });
        const rest: AdmKnowledgeRestPort = { read: fail, list: fail, search: fail };
        const adapter = createAdmKnowledgeAdapter(rest);
        const request = operation === "read" ? adapter.read("item-id")
          : operation === "list" ? adapter.list("policy")
          : adapter.search("query", "policy");

        await expect(request).rejects.toMatchObject({
          code,
          name: "AdmConnectorError",
          message: "ADM knowledge request failed",
          cause: rejection,
        });
        await expect(request).rejects.toBeInstanceOf(AdmConnectorError);
        await expect(request).rejects.not.toHaveProperty("message", expect.stringContaining(marker));
        expect(fail).toHaveBeenCalledOnce();
      });
    }

    it(`${operation}: preserves an existing connector error by identity`, async () => {
      const original = new AdmConnectorError("ADM_FORBIDDEN", "existing error");
      const fail = vi.fn(async () => { throw original; });
      const rest: AdmKnowledgeRestPort = { read: fail, list: fail, search: fail };
      const adapter = createAdmKnowledgeAdapter(rest);
      const request = operation === "read" ? adapter.read("item-id")
        : operation === "list" ? adapter.list("policy")
        : adapter.search("query", "policy");
      await expect(request).rejects.toBe(original);
      expect(fail).toHaveBeenCalledOnce();
    });
  }
});
