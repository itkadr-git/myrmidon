import type { Db } from "@myrmidon/db";
import { poolChatModuleInstances } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import { authorizationService, type AuthorizationDecision } from "../../services/authorization.js";

export const POOL_CHAT_PERMISSION = "chat:invoke" as const;

export type PoolChatScope = {
  moduleId: string;
  channelId: string;
  subjectId: string;
};

export async function authorizePoolChatInvocation(
  db: Db,
  input: {
    companyId: string;
    principalType: "user" | "agent";
    principalId: string;
    moduleId: string;
    channelId: string;
    subjectId: string;
  },
): Promise<AuthorizationDecision> {
  const module = await db
    .select({ id: poolChatModuleInstances.id })
    .from(poolChatModuleInstances)
    .where(
      and(
        eq(poolChatModuleInstances.companyId, input.companyId),
        eq(poolChatModuleInstances.id, input.moduleId),
        eq(poolChatModuleInstances.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (!module) {
    return {
      allowed: false,
      action: POOL_CHAT_PERMISSION,
      reason: "deny_scope",
      explanation: "Pool-chat module is not active in this company.",
    };
  }

  return authorizationService(db).decidePrincipalGrant({
    companyId: input.companyId,
    principalType: input.principalType,
    principalId: input.principalId,
    action: POOL_CHAT_PERMISSION,
    permissionKey: POOL_CHAT_PERMISSION,
    scope: {
      moduleId: input.moduleId,
      channelId: input.channelId,
      subjectId: input.subjectId,
    },
  });
}
