// myrmidon(GOOGLE-AI-CONNECT-UI): the agent identity a call runs under.
//
// The caller is the agent itself — the board resolved its key — so the
// identity carries the agent id, the company it works for, and its board
// role, which is the label a `caste` grant matches on. The HTTP call route
// and the MCP surface both build the identity here, so the two cannot
// disagree about who is calling or which grants apply.

import type { Request } from "express";
import { unauthorized } from "../../errors.js";
import type { GoogleAiConnectorService } from "./service.js";
import type { GaiAgentIdentity } from "./types.js";

export async function gaiAgentIdentity(
  service: GoogleAiConnectorService,
  req: Request,
): Promise<GaiAgentIdentity> {
  const actor = req.actor;
  if (!actor || actor.type !== "agent" || !actor.agentId) throw unauthorized("Agent access required");
  return {
    agentId: actor.agentId,
    companyId: actor.companyId ?? null,
    caste: await service.agentCaste(actor.agentId),
  };
}
