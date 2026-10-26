import { describe, expect, it } from "vitest";
import { INTERACTION_ROUTE_TYPES } from "@myrmidon/shared";
import {
  InteractionRecipientUnresolvedError,
  resolveInteractionRecipient,
  type ResolveInteractionRecipientInput,
} from "./resolve-recipient.js";

const base: ResolveInteractionRecipientInput = {
  routeType: "decision",
  kind: "request_confirmation",
  creator: { agentId: "creator" },
  projectId: "project-1",
  casteScope: { projectId: "project-1", casteKey: "review" },
  projectRoles: {
    lead: { type: "agent", agentId: "review-lead", projectId: "project-1", casteKey: "review", isJoinedMember: true },
  },
};

describe("resolveInteractionRecipient", () => {
  it.each(INTERACTION_ROUTE_TYPES)("resolves %s to a typed recipient", (routeType) => {
    const input: ResolveInteractionRecipientInput = routeType === "operator_action"
      ? { ...base, routeType, serviceQueue: "recovery" }
      : routeType === "human_input"
        ? { ...base, routeType, recipient: { userId: "human" } }
        : { ...base, routeType };
    expect(resolveInteractionRecipient(input)).toEqual(
      routeType === "operator_action" ? { serviceQueue: "recovery" }
        : routeType === "human_input" ? { userId: "human" }
          : { agentId: "review-lead" },
    );
  });

  it.each([
    ["decision", "request_confirmation"],
    ["approval", "request_checkbox_confirmation"],
  ] as const)("rejects %s without a matching project role or recipient", (routeType, kind) => {
    expect(() => resolveInteractionRecipient({ ...base, routeType, kind, projectRoles: undefined }))
      .toThrow(InteractionRecipientUnresolvedError);
  });

  it("requires a service queue for operator actions", () => {
    expect(() => resolveInteractionRecipient({ ...base, routeType: "operator_action" }))
      .toThrow(InteractionRecipientUnresolvedError);
  });

  it("requires a concrete user for human input", () => {
    expect(() => resolveInteractionRecipient({ ...base, routeType: "human_input" }))
      .toThrow(InteractionRecipientUnresolvedError);
    expect(() => resolveInteractionRecipient({ ...base, routeType: "human_input", recipient: { agentId: "other-agent" } }))
      .toThrow(InteractionRecipientUnresolvedError);
  });

  it("skips non-members and never resolves to the creator", () => {
    expect(() => resolveInteractionRecipient({ ...base, projectRoles: {
      lead: { type: "agent", agentId: "creator", projectId: "project-1", casteKey: "review", isJoinedMember: true },
    } })).toThrow(InteractionRecipientUnresolvedError);
    expect(() => resolveInteractionRecipient({ ...base, projectRoles: {
      lead: { type: "agent", agentId: "other-agent", projectId: "project-1", casteKey: "review", isJoinedMember: false },
    } })).toThrow(InteractionRecipientUnresolvedError);
  });

  it("never routes to the creator", () => {
    expect(() => resolveInteractionRecipient({ ...base, projectRoles: {
      lead: { type: "agent", agentId: "creator", projectId: "project-1", casteKey: "review", isJoinedMember: true },
    } })).toThrow(InteractionRecipientUnresolvedError);
    expect(() => resolveInteractionRecipient({
      ...base, routeType: "human_input", recipient: { userId: "creator-user" }, creator: { userId: "creator-user" },
    })).toThrow(/creator/);
  });

  it("rejects project or caste mismatches", () => {
    expect(() => resolveInteractionRecipient({
      ...base, projectRoles: { lead: { type: "agent", agentId: "wrong-project", projectId: "project-2", isJoinedMember: true } },
    })).toThrow(InteractionRecipientUnresolvedError);
    expect(() => resolveInteractionRecipient({
      ...base, projectRoles: { lead: { type: "agent", agentId: "wrong-caste", casteKey: "engineering", isJoinedMember: true } },
    })).toThrow(InteractionRecipientUnresolvedError);
    expect(() => resolveInteractionRecipient({
      ...base, projectRoles: { lead: { type: "agent", agentId: "review-lead", projectId: "project-1", casteKey: "ops", isJoinedMember: true } },
    })).toThrow(InteractionRecipientUnresolvedError);
  });

  it("never routes code review to a user owner", () => {
    expect(() => resolveInteractionRecipient({ ...base, kind: "code_review", recipient: { userId: "owner" } }))
      .toThrow(/Code review/);
  });

  it("uses the first eligible technical review role", () => {
    expect(resolveInteractionRecipient({
      ...base,
      kind: "code_review",
      projectRoles: {
        lead: { type: "agent", agentId: "creator", projectId: "project-1", casteKey: "review", isJoinedMember: true },
        architect: { type: "agent", agentId: "architect", projectId: "project-1", casteKey: "review", isJoinedMember: true },
        secondary_reviewer: { type: "agent", agentId: "secondary", projectId: "project-1", casteKey: "review", isJoinedMember: true },
      },
    })).toEqual({ agentId: "architect" });
  });
});
