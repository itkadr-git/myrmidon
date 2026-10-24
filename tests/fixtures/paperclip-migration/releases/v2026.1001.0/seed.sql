-- Synthetic Paperclip Common Seed Data for Migration Verification
-- Neutral test values only; no real keys, no production data.

-- 1. Company
INSERT INTO "companies" (
  "id", "name", "description", "status", "issue_prefix", "issue_counter", "budget_monthly_cents"
) VALUES (
  'c0000000-0000-4000-a000-000000000001',
  'Acme Synthetic Robotics',
  'Synthetic test company for migration verification',
  'active',
  'ACME',
  10,
  50000
) ON CONFLICT ("id") DO NOTHING;

-- 2. Projects
INSERT INTO "projects" ("id", "company_id", "name", "description", "status") VALUES
  ('f7f1434e-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'Core Platform', 'Main infrastructure and services', 'active'),
  ('f7f1434e-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'Automation Tools', 'Agent tools and skills', 'active')
ON CONFLICT ("id") DO NOTHING;

-- 3. Agents
INSERT INTO "agents" ("id", "company_id", "name", "role", "title", "status") VALUES
  ('a0000000-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'synt-lead-agent', 'lead', 'Lead Engineer', 'active'),
  ('a0000000-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'synt-worker-agent', 'engineer', 'Automation Worker', 'idle')
ON CONFLICT ("id") DO NOTHING;

-- 4. Issues
INSERT INTO "issues" ("id", "company_id", "project_id", "identifier", "title", "status", "priority") VALUES
  ('57fdbf2f-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'f7f1434e-0000-4000-a000-000000000001', 'ACME-1', 'Setup initial robotics pipeline', 'done', 'high'),
  ('57fdbf2f-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'f7f1434e-0000-4000-a000-000000000001', 'ACME-2', 'Implement telemetry collection', 'in_progress', 'medium'),
  ('57fdbf2f-0000-4000-a000-000000000003', 'c0000000-0000-4000-a000-000000000001', 'f7f1434e-0000-4000-a000-000000000002', 'ACME-3', 'Review sensor calibrations', 'todo', 'low')
ON CONFLICT ("id") DO NOTHING;

-- 5. Comments
INSERT INTO "issue_comments" ("id", "company_id", "issue_id", "author_type", "author_agent_id", "body") VALUES
  ('c0000000-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000001', 'agent', 'a0000000-0000-4000-a000-000000000001', 'Initial pipeline completed and verified with mock telemetry.'),
  ('c0000000-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000002', 'agent', 'a0000000-0000-4000-a000-000000000002', 'Working on buffering logic for telemetry events.'),
  ('c0000000-0000-4000-a000-000000000003', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000002', 'agent', 'a0000000-0000-4000-a000-000000000001', 'Ensure retry backoff is configured according to guidelines.')
ON CONFLICT ("id") DO NOTHING;

-- 6. Documents & Issue Documents
INSERT INTO "documents" ("id", "company_id", "title", "format", "latest_body") VALUES
  ('d0000000-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'Architecture Plan', 'markdown', '# Platform Architecture

Microservice definitions and telemetry specs.'),
  ('d0000000-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'Calibration Standards', 'markdown', '# Sensor Calibration Standards

Acceptable deviation thresholds.')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "issue_documents" ("id", "company_id", "issue_id", "document_id", "key") VALUES
  ('655fec76-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000001', 'd0000000-0000-4000-a000-000000000001', 'plan'),
  ('655fec76-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000003', 'd0000000-0000-4000-a000-000000000002', 'standards')
ON CONFLICT ("id") DO NOTHING;

-- 7. Instance Settings
INSERT INTO "instance_settings" ("id", "singleton_key", "general", "experimental") VALUES
  ('82bc9276-0000-4000-a000-000000000001', 'default', '{"theme": "dark", "locale": "en", "retentionDays": 30}', '{"enableLiveLogs": true}')
ON CONFLICT ("singleton_key") DO UPDATE SET "general" = EXCLUDED."general";

-- 8. Company Skills
INSERT INTO "company_skills" ("id", "company_id", "key", "slug", "name", "description", "markdown") VALUES
  ('f76db3cd-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'telemetry-parser', 'telemetry-parser', 'Telemetry Parser', 'Parses raw binary robot telemetry', '# Telemetry Parser
Instructions for parser.'),
  ('f76db3cd-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'log-analyzer', 'log-analyzer', 'Log Analyzer', 'Analyzes error rate spikes', '# Log Analyzer
Instructions for log analysis.')
ON CONFLICT ("id") DO NOTHING;

-- 9. Tool Connections & Grants
INSERT INTO "tool_applications" ("id", "company_id", "name", "type") VALUES
  ('a7c1e5d2-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'GitHub', 'custom'),
  ('a7c1e5d2-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'Cloud Storage', 'custom')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "tool_connections" (
  "id", "company_id", "application_id", "name", "uid", "transport", "connection_kind", "auth_kind", "status"
) VALUES
  ('df84b152-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'a7c1e5d2-0000-4000-a000-000000000001', 'GitHub Integration', 'conn-gh-01', 'rest_api', 'managed', 'api_key', 'active'),
  ('df84b152-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'a7c1e5d2-0000-4000-a000-000000000002', 'Cloud Bucket', 'conn-s3-01', 'rest_api', 'managed', 'api_key', 'active')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "connection_grants" ("id", "company_id", "connection_id", "kind") VALUES
  ('58bf8ffe-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'df84b152-0000-4000-a000-000000000001', 'organization')
ON CONFLICT ("id") DO NOTHING;

-- 10. Heartbeat Runs
INSERT INTO "heartbeat_runs" (
  "id", "company_id", "agent_id", "status", "invocation_source", "started_at", "finished_at"
) VALUES
  ('7e7aa34f-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000001', 'succeeded', 'timer', now() - interval '2 hours', now() - interval '1 hour 55 minutes'),
  ('7e7aa34f-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'a0000000-0000-4000-a000-000000000002', 'succeeded', 'assignment', now() - interval '1 hour', now() - interval '50 minutes')
ON CONFLICT ("id") DO NOTHING;

-- 11. Company Secrets & Versions
INSERT INTO "company_secrets" ("id", "company_id", "key", "name", "status", "provider") VALUES
  ('6b5c0bb8-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'SYNTH_API_KEY', 'Synthetic Integration API Key', 'active', 'local_encrypted'),
  ('6b5c0bb8-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'SYNTH_DATABASE_PASSWORD', 'Synthetic DB Password', 'active', 'local_encrypted')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "company_secret_versions" (
  "id", "secret_id", "version", "material", "value_sha256", "fingerprint_sha256", "status"
) VALUES
  ('19ea90cd-0000-4000-a000-000000000001', '6b5c0bb8-0000-4000-a000-000000000001', 1, '{"scheme":"local_encrypted_v1","iv":"AQIDBAUGBwgJCgsM","tag":"qtdgDHxEmq7yAD9zY39zrA==","ciphertext":"lJ8m7TT1lgznOKvyULblpjBozSonXs1Ct+GSb9HI6UIweC2DYvLC2xOPqJE3nW8="}'::jsonb, 'b0cb631dc3f3e42fbdd1c4ac71c7d2614e109dba7c3fb21be6f81c7802a4c639', 'b0cb631dc3f3e42fbdd1c4ac71c7d2614e109dba7c3fb21be6f81c7802a4c639', 'current'),
  ('19ea90cd-0000-4000-a000-000000000002', '6b5c0bb8-0000-4000-a000-000000000002', 1, '{"scheme":"local_encrypted_v1","iv":"CgsMDQ4PEBESExQV","tag":"50IL1lkb9OyW+Ny0dUswlA==","ciphertext":"6f2q79S8ZrLFm9xE3GlX+HgdverhWpsqq/bG3mE45r1tKxGmA8XxO8fl"}'::jsonb, '801ce49eb49dfec1ab9dc52efc4b594455f6e6283f0c0a7fdd578241bb95e5ba', '801ce49eb49dfec1ab9dc52efc4b594455f6e6283f0c0a7fdd578241bb95e5ba', 'current')
ON CONFLICT ("id") DO NOTHING;

-- 12. Assets & Issue Attachments
INSERT INTO "assets" (
  "id", "company_id", "provider", "object_key", "content_type", "byte_size", "sha256", "original_filename"
) VALUES
  ('6d034d46-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'local_disk', 'storage/spec-v1.md', 'text/markdown', 114, '9ab65856d1dbffab4939cfe447fcab2a77cc84dd73c2b150229ac0ec580da02b', 'spec-v1.md'),
  ('6d034d46-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'local_disk', 'storage/architecture-overview.txt', 'text/plain', 151, 'd44702db3699d4052a2056a4d774a999faabb69576ff132465898ae65abc7884', 'architecture-overview.txt')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "issue_attachments" ("id", "company_id", "issue_id", "asset_id") VALUES
  ('0dd7f2fe-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000001', '6d034d46-0000-4000-a000-000000000001'),
  ('0dd7f2fe-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000002', '6d034d46-0000-4000-a000-000000000002')
ON CONFLICT ("id") DO NOTHING;

-- Vendor-only table: chat_github_reviews (present in 1001.0+)
INSERT INTO "chat_endpoints" (
  "id", "company_id", "connection_id", "provider", "public_id", "assigned_agent_id", "status", "capabilities", "setup"
) VALUES (
  '3211a7b3-0000-4000-a000-000000000001',
  'c0000000-0000-4000-a000-000000000001',
  'df84b152-0000-4000-a000-000000000001',
  'github',
  'endpoint-gh-01',
  'a0000000-0000-4000-a000-000000000001',
  'active',
  '{}'::jsonb,
  '{}'::jsonb
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "chat_github_reviews" (
  "id", "company_id", "endpoint_id", "issue_id", "run_id", "repository_id", "repository", "pull_number", "head_sha", "delivery_id", "configuration_revision", "policy_snapshot", "event", "state"
) VALUES (
  'a5be3d67-0000-4000-a000-000000000001',
  'c0000000-0000-4000-a000-000000000001',
  '3211a7b3-0000-4000-a000-000000000001',
  '57fdbf2f-0000-4000-a000-000000000001',
  '7e7aa34f-0000-4000-a000-000000000001',
  'repo-synth-1',
  'acme/robotics',
  42,
  '0123456789abcdef0123456789abcdef01234567',
  'deliv-001',
  1,
  '{}'::jsonb,
  '{}'::jsonb,
  'completed'
) ON CONFLICT ("id") DO NOTHING;
