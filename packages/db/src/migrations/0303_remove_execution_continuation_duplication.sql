-- Миграция для удаления дублирования executionContinuation в таблице heartbeat_runs
-- Удаляем поле executionContinuation из верхнего уровня, так как оно дублируется внутри paperclipWake

-- Удаляем колонку execution_continuation, если она существует
ALTER TABLE heartbeat_runs 
DROP COLUMN IF EXISTS execution_continuation;

-- Если executionContinuation хранится как отдельное поле на верхнем уровне JSON в result_json, 
-- перемещаем его содержимое внутрь paperclipWake и удаляем из верхнего уровня

-- Для существующих записей: обновляем result_json, перемещая executionContinuation внутрь paperclipWake
UPDATE heartbeat_runs 
SET result_json = 
  CASE 
    WHEN result_json ? 'executionContinuation' AND result_json->'paperclipWake' IS NOT NULL THEN
      jsonb_set(
        jsonb_set(result_json, '{paperclipWake}', 
          COALESCE(result_json->'paperclipWake', '{}') || jsonb_build_object(
            'executionContinuation', result_json->'executionContinuation'
          )
        ),
        '{executionContinuation}',
        'null'
      )
    WHEN result_json ? 'executionContinuation' AND (result_json->'paperclipWake' IS NULL OR result_json->'paperclipWake' = 'null'::jsonb) THEN
      jsonb_set(
        jsonb_set(result_json, '{paperclipWake}', 
          jsonb_build_object('executionContinuation', result_json->'executionContinuation')
        ),
        '{executionContinuation}',
        'null'
      )
    ELSE result_json
  END
WHERE result_json IS NOT NULL 
  AND result_json != '{}'::jsonb
  AND result_json ? 'executionContinuation';