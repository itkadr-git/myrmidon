// myrmidon(1.6.5 BASE-SKILLS): the shared contract of the company base-skills
// registry.
//
// A base skill is a skill the company declares mandatory for every agent. The
// board keeps the list in the interface (Skills screen, "Base skills"), the
// server applies it to every agent automatically (a new agent at creation, an
// existing agent when the skill joins the list or when the board presses
// "Apply to all agents"), and the same screen shows who does not have which
// base skill yet.
//
// This module is the shared half: types and zod validators only — no I/O, no
// database access — so the server, the UI and the tests all read one contract.
// Field names are fixed: later changes may only ADD optional fields.

import { z } from "zod";

/** The most base skills one company may declare (one per library skill). */
export const COMPANY_BASE_SKILLS_MAX = 200;

/** One declared base skill, joined with the library entry it points at. */
export interface CompanyBaseSkillEntry {
  key: string;
  /** The library skill id; `null` when the library no longer has this key. */
  skillId: string | null;
  name: string | null;
  slug: string | null;
  iconUrl: string | null;
  color: string | null;
  /** True when the library has no skill with this key (nothing to deliver). */
  missing: boolean;
  /** Agents that already carry the skill in their own selection. */
  assignedAgentCount: number;
  /** Agents the skill is expected on (terminated agents are not counted). */
  agentCount: number;
  createdAt: string;
}

/** Why one agent does not carry one base skill. */
export type CompanyBaseSkillGapReason = "not_assigned" | "adapter_unsupported";

/** One agent that is missing one base skill. */
export interface CompanyBaseSkillGap {
  key: string;
  agentId: string;
  agentName: string;
  agentStatus: string;
  reason: CompanyBaseSkillGapReason;
}

/** The agent list the base-skills screen and the gaps are computed against. */
export interface CompanyBaseSkillAgent {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  /** False when the agent's adapter cannot receive skills at all. */
  skillsSupported: boolean;
}

/** Everything the base-skills screen needs in one response. */
export interface CompanyBaseSkillOverview {
  entries: CompanyBaseSkillEntry[];
  gaps: CompanyBaseSkillGap[];
  agents: CompanyBaseSkillAgent[];
}

/** The outcome of applying the base list to agents. */
export interface CompanyBaseSkillApplyResult {
  /** Base skill keys that were applied. */
  keys: string[];
  /** Agents examined (terminated and pending-approval agents are skipped). */
  agents: number;
  /** Agents whose own skill selection actually changed. */
  changed: number;
  /** Agents that already carried every base skill. */
  unchanged: number;
  /** Agents the server could not update, with the reason. */
  failed: Array<{ agentId: string; agentName: string; reason: string }>;
}

/** What every base-skills mutation answers with: the list after the change. */
export interface CompanyBaseSkillMutationResponse {
  overview: CompanyBaseSkillOverview;
  apply: CompanyBaseSkillApplyResult;
}

/** What removing one base skill answers with. */
export interface CompanyBaseSkillRemoveResponse {
  overview: CompanyBaseSkillOverview;
  removed: string;
}

/** Add one or more library skills to the company base list. */
export const companyBaseSkillAddSchema = z.object({
  keys: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(COMPANY_BASE_SKILLS_MAX),
});

export type CompanyBaseSkillAddRequest = z.infer<typeof companyBaseSkillAddSchema>;