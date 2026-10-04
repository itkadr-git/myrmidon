-- myrmidon(OPE-4130): partial indexes for chat reconciliation performance
-- Add partial indexes to optimize queries for pending/retry states in chat publications and actions

-- Partial index for chat_publications to optimize queries looking for pending or retry states
-- This targets the common query pattern for finding work that needs to be processed
CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_publications_work_pending_retry_idx 
ON chat_publications (state, next_attempt_at) 
WHERE state IN ('pending', 'retry', 'streaming');

-- Partial index for chat_actions to optimize queries looking for pending/retry states
-- This targets the common query pattern for finding actions that need to be processed
CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_actions_work_pending_retry_idx 
ON chat_actions (status, created_at, id) 
WHERE status IN ('received', 'processing');