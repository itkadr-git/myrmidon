UPDATE "issues"
SET "execution_policy" = jsonb_set("execution_policy", '{mode}', '"normal"')
WHERE "execution_policy"->>'mode' = 'sequential';
