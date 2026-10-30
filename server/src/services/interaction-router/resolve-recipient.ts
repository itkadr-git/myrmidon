import type {
  InteractionRecipient,
  InteractionRouteType,
} from "@myrmidon/shared";

export type InteractionKind =
  | "decision"
  | "approval"
  | "operator_action"
  | "human_input"
  | string;

export type ProjectInteractionRole = "lead" | "architect" | "secondary_reviewer";

export interface InteractionPrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
  projectId?: string | null;
  casteKey?: string | null;
}

export interface InteractionProjectRoles {
  lead?: InteractionPrincipal | null;
  architect?: InteractionPrincipal | null;
  secondary_reviewer?: InteractionPrincipal | null;
}

export interface InteractionCasteScope {
  projectId?: string | null;
  casteKey?: string | null;
}

export interface ResolveInteractionRecipientInput {
  routeType: InteractionRouteType;
  kind: InteractionKind;
  projectId?: string | null;
  casteScope?: InteractionCasteScope | null;
  creator: InteractionRecipient;
  projectRoles?: InteractionProjectRoles | null;
  recipient?: InteractionRecipient | null;
  serviceQueue?: string | null;
}

export class InteractionRecipientUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionRecipientUnresolvedError";
  }
}

function principalRecipient(principal: InteractionPrincipal): InteractionRecipient | null {
  if (principal.type === "agent" && principal.agentId) {
    return { agentId: principal.agentId };
  }
  if (principal.type === "user" && principal.userId) {
    return { userId: principal.userId };
  }
  return null;
}

function sameRecipient(a: InteractionRecipient, b: InteractionRecipient): boolean {
  if ("agentId" in a) return "agentId" in b && a.agentId === b.agentId;
  if ("userId" in a) return "userId" in b && a.userId === b.userId;
  return "serviceQueue" in b && a.serviceQueue === b.serviceQueue;
}

function roleRecipient(
  roles: InteractionProjectRoles | null | undefined,
  projectId: string | null | undefined,
  casteScope: InteractionCasteScope | null | undefined,
  kind: InteractionKind,
  creator: InteractionRecipient,
): InteractionRecipient | null {
  for (const role of ["lead", "architect", "secondary_reviewer"] as const) {
    const principal = roles?.[role];
    if (!principal) continue;
    if (principal.projectId && principal.projectId !== (projectId ?? casteScope?.projectId)) continue;
    if (principal.casteKey && principal.casteKey !== casteScope?.casteKey) continue;
    const recipient = principalRecipient(principal);
    if (!recipient || sameRecipient(recipient, creator)) continue;
    if (kind === "code_review" && "userId" in recipient) continue;
    return recipient;
  }
  return null;
}

export function resolveInteractionRecipient(
  input: ResolveInteractionRecipientInput,
): InteractionRecipient {
  let recipient: InteractionRecipient | null = null;

  if (input.routeType === "operator_action") {
    const queue = input.serviceQueue?.trim();
    if (!queue) throw new InteractionRecipientUnresolvedError("operator_action requires a service queue");
    recipient = { serviceQueue: queue };
  } else if (input.routeType === "human_input") {
    recipient = input.recipient && "userId" in input.recipient ? input.recipient : null;
    if (!recipient) throw new InteractionRecipientUnresolvedError("human_input requires a concrete user recipient");
  } else if (input.recipient) {
    recipient = input.recipient;
  } else {
    recipient = roleRecipient(
      input.projectRoles,
      input.projectId,
      input.casteScope,
      input.kind,
      input.creator,
    );
    if (!recipient) throw new InteractionRecipientUnresolvedError(`${input.routeType} requires a typed human or matching project role`);
  }

  if (sameRecipient(recipient, input.creator)) {
    throw new InteractionRecipientUnresolvedError("The interaction creator cannot be its recipient");
  }
  if (
    input.kind === "code_review" &&
    "userId" in recipient
  ) {
    throw new InteractionRecipientUnresolvedError("Code review cannot be assigned to a user");
  }
  return recipient;
}
