-- Миграция для добавления индекса для оптимизации запросов к таблице heartbeat_runs
-- Этот индекс помогает ускорить запросы в getConversationOwnershipBlocker
-- по coalesce(native_issue_id::text, context_snapshot->>'issueId')

CREATE INDEX IF NOT EXISTS heartbeat_runs_company_issue_coalesce_created_idx 
ON heartbeat_runs (
    company_id, 
    (coalesce(native_issue_id::text, context_snapshot->>'issueId')), 
    created_at DESC
);