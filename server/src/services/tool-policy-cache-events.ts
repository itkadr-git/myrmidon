/**
 * OPE-4129: event-based invalidation for the tool-gateway policy snapshot cache.
 *
 * Mutations to tool_profiles / tool_profile_bindings / tool_policies (and any
 * other tool_* policy state) call {@link emitToolPolicyChanged} after a
 * successful write. The tool-gateway policy cache subscribes via
 * {@link onToolPolicyChanged} and drops its in-memory snapshots, so a policy
 * edit becomes visible on the very next tools/list or tool call instead of
 * waiting for a TTL window.
 *
 * Cross-process note: the event is in-process. Deployments running several
 * board processes keep a short safety TTL on the snapshot cache (30s, see
 * tool-gateway.ts) so a mutation in one process is picked up by the others
 * within that bound; within a process the invalidation is immediate.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Notify subscribers that tool policy state changed (call after a successful write). */
export function emitToolPolicyChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must never break the mutation path.
    }
  }
}

/** Subscribe to policy-change events. Returns an unsubscribe function. */
export function onToolPolicyChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
