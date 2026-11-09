import { skillKeyForRole, type ForagingCandidateInput, type ForagingCandidatePort } from "./domain.js";

/** Select destination: role-targeted skills use SKILL-LIFECYCLE candidate. */
export function selectForagingCandidatePort(
  skillPort: ForagingCandidatePort,
  knowledgePort: ForagingCandidatePort,
): ForagingCandidatePort {
  return {
    get available() {
      return skillPort.available || knowledgePort.available;
    },
    async createFindingCandidate(input: ForagingCandidateInput) {
      if (input.skillKey === skillKeyForRole(input.role) && skillPort.available) {
        const candidateRef = await skillPort.createFindingCandidate(input);
        if (candidateRef) return candidateRef;
      }
      return knowledgePort.createFindingCandidate(input);
    },
  };
}
