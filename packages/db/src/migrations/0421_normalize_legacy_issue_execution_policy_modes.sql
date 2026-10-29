-- Normalize retired execution policy modes while preserving the rest of each saved policy.
UPDATE issues
SET execution_policy = jsonb_set(execution_policy, '{mode}', '"normal"'::jsonb, false)
WHERE execution_policy IS NOT NULL
  AND execution_policy ? 'mode'
  AND execution_policy->>'mode' = 'sequential';
