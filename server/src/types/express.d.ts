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
       *
       * Granular reason values (OPE-10599 review):
       *  - `no_credentials` — no bearer token, no session cookie at all.
       *  - `session_resolution_error` — session lookup threw an exception.
       *  - `session_invalid` — session resolved but lacks user/session IDs.
       *  - `public_path_bypass` — MCP/monitoring public-path bypass.
       *  - `agent_token_expired` — bearer JWT past its `exp` claim.
       *  - `agent_token_invalid` — bearer JWT failed signature/malformed.
       *  - `agent_token_agent_mismatch` — JWT claims point at missing/foreign agent.
       *  - `agent_token_agent_terminated` — JWT agent is terminated.
       *  - `agent_token_agent_pending` — JWT agent is pending approval.
       *  - `agent_key_agent_mismatch` — API key points at missing/foreign agent.
       *  - `agent_key_agent_terminated` — key agent is terminated.
       *  - `agent_key_agent_pending` — key agent is pending approval.
       *
       * The token itself is never logged — only the classification.
       */
      actorNoneReason?: string;
    }
  }
}
