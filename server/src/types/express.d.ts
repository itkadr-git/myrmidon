export {};

import type { AgentApiKeyScope, BoardApiKeyScope } from "@myrmidon/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        sessionId?: string | null;
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        onBehalfOfMemberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        boardKeyScope?: BoardApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        identityContextId?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "cloud_control" | "none";
      };
      /**
       * Populated by the actor middleware when the request ends up with an
       * anonymous actor (`actor.type === "none"`). Routes and authz helpers
       * use this to explain in server logs why an unauthenticated request
       * reached a company-resource endpoint instead of a valid credential.
       */
      actorNoneReason?: string;
    }
  }
}
