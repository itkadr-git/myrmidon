import { forbidden } from "../errors.js";

interface ImportActor {
  type: string;
  userId?: string | null;
  source?: string;
  isInstanceAdmin?: boolean;
  memberships?: readonly { companyId: string; status: string; membershipRole?: string | null }[];
}

/** Only a board owner, local operator or instance admin may initiate an import. */
export function assertClaudeProfileImportOwner(actor: ImportActor, companyId: string): void {
  if (actor.type !== "board") throw forbidden("Company owner access required");
  if (actor.source === "local_implicit" || actor.isInstanceAdmin === true) return;
  if (actor.userId && actor.memberships?.some((membership) =>
    membership.companyId === companyId && membership.status === "active" && membership.membershipRole === "owner"
  )) return;
  throw forbidden("Company owner access required");
}
