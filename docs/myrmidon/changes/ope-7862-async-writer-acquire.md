# Async writer acquire

Delta 18 keeps synchronous `SessionDB` callers compatible while moving deferred gateway writer acquisition off the event loop. The awaited transaction performs the complete sidecar scan before connecting, rejects incomplete or held verdicts, and preserves registry ownership, cancellation cleanup, recovery retries, and shutdown drain.

The Docker image applies `18-async-writer-acquire.patch` at the pinned Hermes source. The patch's lifecycle contract is covered by the Hermes regression tests carried in the delta and by the Myrmidon builder checks.
