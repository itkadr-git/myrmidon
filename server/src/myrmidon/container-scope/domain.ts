// server/src/myrmidon/container-scope/domain.ts
//
// myrmidon(CONTAINER-SCOPE): the contract of the container axis for the API and
// the screen. The disk axis (BOT-DISK-F) owns its own contract; this one adds
// the container of an area, its limits and the per-agent pause/restart plan.

import type { Db } from "@paperclipai/db";
import type {
  ContainerAction,
  ContainerMode,
  ContainerLimits,
  IsolationMode,
  IsolationSource,
  ScopeProblem,
  SettableScopeKind,
} from "@paperclipai/shared";

import type { ContainerScopeService } from "./service.js";

/** One configured instance of the container axis. */
export interface ContainerInstanceView {
  kind: SettableScopeKind;
  ref: string;
  /** `per-agent` (default) or `per-scope` (one container for the instance). */
  mode: ContainerMode;
  /** The disk mode of the same instance when the disk axis has one, else null. */
  diskMode: IsolationMode | null;
  label: string;
  /** Agents whose area resolved to this instance. */
  agentCount: number;
}

/** One container, as the runtime sees it. */
export interface ContainerView {
  containerKey: string;
  shared: boolean;
  scope: { kind: SettableScopeKind; ref: string; label: string } | null;
  /** Agent ids and names of the members, sorted by name. */
  members: Array<{ agentId: string; name: string }>;
  limits: ContainerLimits;
  /** The agents of this container that are waiting for a restart. */
  restartRequired: string[];
}

export interface ContainerAgentView {
  agentId: string;
  name: string;
  role: string | null;
  containerKey: string;
  shared: boolean;
  scope: { kind: SettableScopeKind; ref: string; label: string } | null;
  /** Where the area came from (agent, group, caste, subtree, project, catalog, company, default). */
  source: IsolationSource;
  reason: string;
  problems: ScopeProblem[];
  appliedContainerKey: string | null;
  restartRequired: boolean;
  restartReason: string | null;
  /** True when the agent runs in a container (its own or a shared one). */
  enrolled: boolean;
}

export interface ContainerScopeOverview {
  instances: ContainerInstanceView[];
  containers: ContainerView[];
  agents: ContainerAgentView[];
  enrolments: Array<{ containerKey: string; shared: boolean; roster: string[] }>;
  limits: ContainerLimits;
  /** Agents with a shared container in `per-scope` mode. */
  sharedAgentCount: number;
}

export interface ContainerScopeServiceOptions {
  limits?: ContainerLimits;
}

/** One audit row this module writes for a mutation. */
export interface ContainerScopeAudit {
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

export interface ContainerScopeRoutesDeps {
  db: Db;
  service: ContainerScopeService;
}

export interface ContainerScopeActionRequest {
  agentId: string;
  kind: "pause" | "resume" | "restart" | "rollout";
}

export interface ContainerScopeActionResult {
  agentId: string;
  actions: ContainerAction[];
  /** True when the request touched a shared container (the other members keep running). */
  shared: boolean;
}