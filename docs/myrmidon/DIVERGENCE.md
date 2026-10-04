# Myrmidon Divergence Tracking

Tracks vendor-specific modifications for Myrmidon feature releases.

## OPE-4137: 1.6.2 AUTONOMY-MATRIX DELETE Enforcement

**What:** Added autonomy matrix enforcement to DELETE operations on issues, comments, attachments, and inbox archives.

**Where:** `server/src/routes/issues.ts` - added `dbAutonomyGate(db).assertAllowed(req, "delete")` calls to DELETE route handlers.

**Why:** Enforce autonomy matrix restrictions on agent DELETE operations as per 1.6.2 requirements.

**How:** Modified DELETE route handlers to check agent's autonomy matrix permissions before executing delete operations.

**Test:** Added `server/src/routes/issues.autonomy.myrmidon.test.ts` with tests for each affected DELETE endpoint.

**When to remove:** When autonomy matrix feature is deprecated or redesigned.
