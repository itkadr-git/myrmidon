# Capacity policy candidate ordering

`packages/shared` exports `orderCandidatesWithPolicy` from `myrmidon-capacity-policy-order.js` to compose the capacity-policy stages for a candidate queue. It accepts the candidate list, an `enabled` flag, policy options, and optional `CapacityPolicyPorts` providers. The providers default to the capacity checks, starvation protection, and project-fairness implementations in `myrmidon-capacity-policy.ts`.

When `enabled` is false, candidates retain the canonical legacy order from `orderSwarmQueueCandidates`, and `rejected` is empty. When enabled, the composer applies capacity checks first; rejected candidates include a reason such as `project_limit` or `caste_limit`. It then applies starvation promotion and project fairness, and sorts by effective priority, fair position, score, and original queue position. The comparator leaves the global swarm priority ranks unchanged. Missing `createdAt` values use the existing safe fallback behavior.

This is a shared ordering utility; its export does not itself enable or schedule a production capacity-policy rollout. Use the existing capacity-policy configuration and approved rollout procedure for operational changes.
