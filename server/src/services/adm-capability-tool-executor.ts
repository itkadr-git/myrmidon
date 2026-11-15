import type { Db } from "@myrmidon/db";
import { toolConnections } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import type {
  AdmCapabilityExecutor,
} from "./adm-access-request.js";

/**
 * 1.7 COMPANY-BOUNDARIES (OPE-12766, ADR-0052 step 5): the controlled
 * execution seam for `invoke_tool` capabilities. Instead of reporting a
 * canned success for any active connection, the executor performs the real
 * bounded operation through the tool gateway's policy/audit/dispatch path
 * (`executeTestCall` — the same path the board's Test tab uses). The ADM
 * capability supplies the company/connection/tool binding; arguments come
 * from the approved scope, never from the caller of `executeCapability`,
 * so the approved scope fully constrains the operation.
 */
export function createAdmCapabilityToolExecutor(
  db: Db,
  getToolGateway: () => unknown,
): AdmCapabilityExecutor {
  return {
    async execute(input) {
      // Deny-by-default: only tool resources are executable via this seam.
      if (input.resourceType !== "tool") {
        return {
          executed: false,
          result: { reason: "resource_type_not_executable" },
        };
      }

      const [connection] = await db
        .select({ id: toolConnections.id, name: toolConnections.name })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, input.targetCompanyId),
            eq(toolConnections.name, input.resourceKey),
          ),
        )
        .limit(1);

      if (!connection) {
        return {
          executed: false,
          result: { reason: "tool_connection_not_found" },
        };
      }

      const gateway = getToolGateway() as {
        executeTestCall?: (input: {
          companyId: string;
          connectionId: string;
          agentId: string;
          userId: string;
          toolName: string;
          parameters?: unknown;
          timeoutMs?: number;
        }) => Promise<{
          decision: "allowed" | "off" | "ask_first";
          invocationId?: string;
          actionRequestId?: string;
          result?: unknown;
          error?: { message: string; reasonCode: string };
        }>;
      };

      if (!gateway || typeof gateway.executeTestCall !== "function") {
        return {
          executed: false,
          result: { reason: "tool_gateway_unavailable" },
        };
      }

      const scope = input.scope;
      // Arguments are taken from the approved scope only — the caller of
      // executeCapability cannot smuggle parameters past the approval.
      const parameters = (scope.parameters ?? scope.arguments ?? scope.input ?? {}) as Record<string, unknown>;
      const toolName =
        typeof scope.toolName === "string" && scope.toolName.trim().length > 0
          ? scope.toolName.trim()
          : input.resourceKey;

      const actor = input.actor;
      const gatewayInput = {
        companyId: input.targetCompanyId,
        connectionId: connection.id,
        agentId: actor.agentId ?? actor.actorId,
        userId: actor.userId ?? actor.actorId,
        toolName,
        parameters,
        timeoutMs:
          typeof scope.operationTimeoutSeconds === "number"
            ? Math.min(Math.max(Math.round(scope.operationTimeoutSeconds * 1000), 1_000), 60_000)
            : undefined,
      };

      try {
        const outcome = await gateway.executeTestCall(gatewayInput);

        if (outcome.decision === "allowed" && outcome.error) {
          return {
            executed: false,
            result: {
              kind: "tool_execution_result",
              status: "failed",
              reason: outcome.error.reasonCode || "tool_execution_failed",
              message: outcome.error.message,
              invocationId: outcome.invocationId ?? null,
            },
          };
        }
        if (outcome.decision === "off" || outcome.decision === "ask_first") {
          // Policy said off/denied, or policy requires ask-first approval the
          // capability flow cannot complete: honest no-execution.
          return {
            executed: false,
            result: {
              kind: "tool_execution_result",
              status: "denied",
              reason: outcome.decision === "off" ? "policy_denied" : "policy_requires_approval",
              invocationId: outcome.invocationId ?? null,
              actionRequestId: outcome.actionRequestId ?? null,
            },
          };
        }

        return {
          executed: true,
          result: {
            kind: "tool_execution_result",
            status: "succeeded",
            invocationId: outcome.invocationId ?? null,
            output: outcome.result ?? null,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "tool execution failed";
        return {
          executed: false,
          result: {
            kind: "tool_execution_result",
            status: "failed",
            reason: "tool_execution_failed",
            message,
          },
        };
      }
    },
  };
}
