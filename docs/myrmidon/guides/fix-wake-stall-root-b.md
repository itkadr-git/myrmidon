# Fix for WAKE-STALL-ROOT B Issue

## Problem Description
After changing the issue assignee (`PATCH /api/issues/{id}` with new `assigneeAgentId`), deferred issue execution (`deferred_issue_execution`) transitions to the new assignee and wakes them, instead of remaining stuck with the old assignee.

## Root Cause
When an issue is reassigned from one agent to another, the system was not properly cancelling the deferred executions associated with the old assignee. This caused:
1. The old agent to retain stale deferred executions
2. The new assignee to not receive proper wakeups
3. Stalled processing of the reassigned issue

## Solution Implemented

### 1. New Service Method
Added a new method `cancelDeferredExecutionsForAgentOnReassignment` in the issues service to cancel all deferred executions for the old assignee when an issue is reassigned.

### 2. Integration in PATCH Handler
Modified the PATCH handler in `server/src/routes/issues.ts` to call this cancellation method when the assignee changes.

### 3. Proper Handling of Edge Cases
- Handles cases where no deferred executions exist for the old agent
- Ensures only executions related to the specific issue are cancelled
- Maintains proper logging of the cancellation events
- Respects agent pause states - paused agents remain paused but their deferred executions are cleared

## Files Modified

### server/src/services/issues.ts
- Added `cancelDeferredExecutionsForAgentOnReassignment` method to cancel deferred executions for old assignee
- Method properly filters by issue ID and agent ID to avoid cancelling unrelated executions

### server/src/routes/issues.ts
- Enhanced assignee change detection logic
- Added call to cancellation method when assignee changes

### Test Coverage
- Added comprehensive tests in `server/src/__tests__/issue-reassignment-deferred-execution.myrmidon.test.ts`
- Tests cover normal reassignment scenarios
- Tests cover edge cases (no deferred executions, multiple deferred executions)

## Verification

### Test Results
- All new tests pass
- Existing functionality remains unaffected
- Deferred executions are properly cancelled when reassignment occurs
- New assignee receives appropriate wakeups after reassignment

### Behavior Changes
1. ✅ Old assignee's deferred executions are cancelled on reassignment
2. ✅ New assignee receives wakeups for the reassigned issue
3. ✅ No impact on unrelated deferred executions
4. ✅ Proper logging of reassignment events
5. ✅ Handles paused agents correctly