// myrmidon(PLS2): scope attribution for worker->host calls that carry no
// invocation id while ANY host-issued invocation of one company is in flight.
//
// Background. The host registers an invocation scope for every host->worker
// call that carries a company (`handleApiRequest`, `onEvent`, `performAction`,
// `getData`, `executeTool`, environment calls). A worker built with a plugin
// SDK that echoes the invocation id sends it back on nested calls. A worker
// whose bundle contains an older SDK copy never echoes it, so every nested
// call that references a company was answered with "missing, expired, or
// unknown invocation scope". This is the PLS1 rule, extended from "in-flight
// plugin API route calls only" to "any in-flight invocation", because bridge
// entry points (`getData`, `performAction`, `executeTool`) register their
// invocation scope without ever setting the apiRoute marker, so un-echoed
// nested calls issued from those handlers (the LLM Wiki `localFolders.*`
// calls) kept failing.
//
// Rule. A worker->host call with NO invocation id at all is attributed to the
// company of the in-flight invocations, only when ALL in-flight invocations
// of ANY kind (route calls, events, actions, data reads, tool calls,
// environment calls) belong to that one company. The host cannot tell which
// handler an un-echoed call came from, so an in-flight invocation of another
// company makes the attribution ambiguous and the call stays denied. A call
// with an unknown or forged id is not affected: it is still denied by the
// caller.
//
// Why this grants nothing new. The worker received the invocation id of each
// in-flight call and could echo it on any nested call; attributing an
// un-echoed call to the same company yields the same scope. The scope is
// always the host-issued one, never a value from the worker, and a call that
// references another company still fails the company match in the host
// client.
//
// Cost. An `onEvent` invocation registered through `notify` lives up to its
// TTL (15 minutes), so an event of another company keeps the attribution
// denied for that long even if the handler has already finished.

export interface InvocationScopeCandidate {
  scope: { companyId: string };
  /** Kept for registry compatibility: true only for `handleApiRequest`. */
  apiRoute?: boolean;
}

/**
 * Pick the in-flight invocation an un-echoed worker call is attributed to.
 * Returns `null` when there is no in-flight invocation at all, or when any
 * in-flight invocation belongs to another company, so the caller keeps
 * denying the call.
 */
export function resolveUnechoedInvocation<T extends InvocationScopeCandidate>(
  activeInvocations: Iterable<T>,
): T | null {
  let match: T | null = null;
  let companyId: string | null = null;
  for (const entry of activeInvocations) {
    if (companyId !== null && entry.scope.companyId !== companyId) return null;
    companyId = entry.scope.companyId;
    match ??= entry;
  }
  return match;
}
