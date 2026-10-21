#!/usr/bin/env node
// Generates or updates the synthetic Paperclip migration fixtures
// (canonical schema DDL, seed SQL, sample storage attachments, and verification manifests)
// for all supported vendor releases in the registry:
//   - v2026.916.0
//   - v2026.916.1
//   - v2026.1001.0
//   - v2026.1005.0
//   - v2026.1012.0

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests/fixtures/paperclip-migration");
const STORAGE_DIR = path.join(FIXTURES_DIR, "storage");

export const SUPPORTED_RELEASES = [
  {
    tag: "v2026.916.0",
    sha: "602330cfd8fa6e0a8ec20ee1f32a243a7550dd70",
    lastMigration: "0279_tired_deathstrike",
    migrationCount: 278,
    extraTables: [],
    extraColumns: [],
  },
  {
    tag: "v2026.916.1",
    sha: "d554c4789ed3930f8a53ac9fdf6503b3187097da",
    lastMigration: "0279_tired_deathstrike",
    migrationCount: 278,
    extraTables: [],
    extraColumns: [],
  },
  {
    tag: "v2026.1001.0",
    sha: "88bf9be92a3aaef3b29c15d487bc565e7beff7a6",
    lastMigration: "0283_jittery_psynapse",
    migrationCount: 282,
    extraTables: [
      "routine_webhook_test_receipts",
      "chat_github_configurations",
      "chat_github_registrations",
      "chat_github_reviews",
    ],
    extraColumns: [
      "agents.appearance",
      "routine_triggers.archived",
      "routine_triggers.last_webhook_delivery",
      "routine_triggers.setup_pending",
      "chat_conversations.communication_guidance",
      "chat_endpoints.communication_instructions",
    ],
  },
  {
    tag: "v2026.1005.0",
    sha: "87c9c043e7c808759530432f8319e7ae9b81cf05",
    lastMigration: "0293_broad_rattler",
    migrationCount: 292,
    extraTables: [
      "routine_webhook_test_receipts",
      "chat_github_configurations",
      "chat_github_registrations",
      "chat_github_reviews",
      "runner_api_response_reservations",
      "agent_instruction_heads",
      "agent_instruction_revisions",
      "agent_instruction_working_copies",
      "chat_completion_deliveries",
      "chat_task_handoffs",
      "browser_use_browsers",
      "browser_use_runs",
      "browser_use_sessions",
      "browser_use_settings",
      "company_skill_source_entries",
      "company_skill_sources",
    ],
    extraColumns: [
      "agents.appearance",
      "routine_triggers.archived",
      "routine_triggers.last_webhook_delivery",
      "routine_triggers.setup_pending",
      "chat_conversations.communication_guidance",
      "chat_endpoints.communication_instructions",
      "browser_use_runs.recovery_cursor",
      "company_skill_source_entries.inspection",
      "issues.title_needs_generation",
    ],
  },
  {
    tag: "v2026.1012.0",
    sha: "bba6a45f0d364cfd962ac59b3bdf2426a8222adb",
    lastMigration: "0305_chubby_vin_gonzales",
    migrationCount: 304,
    extraTables: [
      "agent_instruction_heads",
      "agent_instruction_revisions",
      "agent_instruction_working_copies",
      "ai_connection_pools",
      "ai_connection_router_cursors",
      "ai_connection_task_pins",
      "browser_use_browsers",
      "browser_use_runs",
      "browser_use_sessions",
      "browser_use_settings",
      "chat_completion_deliveries",
      "chat_github_configurations",
      "chat_github_registrations",
      "chat_github_reviews",
      "chat_task_handoffs",
      "company_skill_source_entries",
      "company_skill_sources",
      "mcp_event_admissions",
      "mcp_event_deliveries",
      "mcp_event_subscriptions",
      "mcp_mutation_receipts",
      "mcp_oauth_clients",
      "mcp_oauth_device_requests",
      "mcp_oauth_grants",
      "mcp_oauth_metadata_admissions",
      "mcp_oauth_requests",
      "mcp_oauth_tokens",
      "resource_lifecycle_events",
      "routine_webhook_test_receipts",
      "runner_api_response_reservations",
      "tool_connection_app_snapshots",
      "tool_connection_app_syncs",
    ],
    extraColumns: [
      "agents.appearance",
      "routine_triggers.archived",
      "routine_triggers.last_webhook_delivery",
      "routine_triggers.setup_pending",
      "chat_conversations.communication_guidance",
      "chat_endpoints.communication_instructions",
      "browser_use_runs.recovery_cursor",
      "company_skill_source_entries.inspection",
      "issues.title_needs_generation",
      "tool_connection_app_snapshots.error_at",
      "tool_connections.agent_instructions",
      "company_secrets.ai_session_epoch",
      "mcp_oauth_clients.registration_source_hash",
      "mcp_oauth_requests.requested_company_id",
      "mcp_oauth_clients.grant_types",
    ],
  },
];

export const FIXTURE_KEYS = {
  // Test-only synthetic keys (neutral, low-entropy placeholder masks to avoid secret scanner false positives)
  sourceMasterKeyHex: "0101010101010101010101010101010101010101010101010101010101010101",
  targetMasterKeyHex: "0202020202020202020202020202020202020202020202020202020202020202",
};

export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function encryptAes256Gcm(keyBuffer, plaintext, ivBuffer = null) {
  const iv = ivBuffer || randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function generateStorageFiles() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const file1Name = "spec-v1.md";
  const file1Content = "# Synthetic Paperclip Migration Spec\n\nThis is a neutral synthetic attachment file to verify attachment migration.\n";
  const file1Path = path.join(STORAGE_DIR, file1Name);
  fs.writeFileSync(file1Path, file1Content, "utf8");
  const file1Sha = sha256Hex(file1Content);
  const file1Size = Buffer.byteLength(file1Content, "utf8");

  const file2Name = "architecture-overview.txt";
  const file2Content = "Synthetic Architecture Overview\nSource: Paperclip Multi-Release Registry\nTarget: Myrmidon 1.6.6\nVerified: non-empty entities and re-encrypted secrets.\n";
  const file2Path = path.join(STORAGE_DIR, file2Name);
  fs.writeFileSync(file2Path, file2Content, "utf8");
  const file2Sha = sha256Hex(file2Content);
  const file2Size = Buffer.byteLength(file2Content, "utf8");

  return [
    {
      objectKey: `storage/${file1Name}`,
      relativePath: `storage/${file1Name}`,
      sha256: file1Sha,
      byteSize: file1Size,
    },
    {
      objectKey: `storage/${file2Name}`,
      relativePath: `storage/${file2Name}`,
      sha256: file2Sha,
      byteSize: file2Size,
    },
  ];
}

export function generateBaseSeedSql(files, keys) {
  const sourceKeyBuf = Buffer.from(keys.sourceMasterKeyHex, "hex");

  const secret1Key = "SYNTH_API_KEY";
  const secret1Plaintext = "synth-token-42-test-api-key-for-migration-proof";
  const secret1Sha256 = sha256Hex(secret1Plaintext);
  const fixedIv1 = Buffer.from("0102030405060708090a0b0c", "hex");
  const encryptedMaterial1 = encryptAes256Gcm(sourceKeyBuf, secret1Plaintext, fixedIv1);

  const secret2Key = "SYNTH_DATABASE_PASSWORD";
  const secret2Plaintext = "synth-pg-pass-99-neutral-credential-string";
  const secret2Sha256 = sha256Hex(secret2Plaintext);
  const fixedIv2 = Buffer.from("0a0b0c0d0e0f101112131415", "hex");
  const encryptedMaterial2 = encryptAes256Gcm(sourceKeyBuf, secret2Plaintext, fixedIv2);

  const sql = `-- Synthetic Paperclip Common Seed Data for Migration Verification
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
  ('d0000000-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'Architecture Plan', 'markdown', '# Platform Architecture\n\nMicroservice definitions and telemetry specs.'),
  ('d0000000-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'Calibration Standards', 'markdown', '# Sensor Calibration Standards\n\nAcceptable deviation thresholds.')
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
  ('f76db3cd-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'telemetry-parser', 'telemetry-parser', 'Telemetry Parser', 'Parses raw binary robot telemetry', '# Telemetry Parser\nInstructions for parser.'),
  ('f76db3cd-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'log-analyzer', 'log-analyzer', 'Log Analyzer', 'Analyzes error rate spikes', '# Log Analyzer\nInstructions for log analysis.')
ON CONFLICT ("id") DO NOTHING;

-- 9. Tool Connections & Grants
INSERT INTO "tool_connections" (
  "id", "company_id", "application_id", "name", "uid", "transport", "connection_kind", "auth_kind", "status"
) VALUES
  ('df84b152-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'github-app', 'GitHub Integration', 'conn-gh-01', 'http', 'source_control', 'bearer_token', 'active'),
  ('df84b152-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 's3-storage', 'Cloud Bucket', 'conn-s3-01', 's3', 'storage', 'secret_key', 'active')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "connection_grants" ("id", "company_id", "connection_id", "kind") VALUES
  ('58bf8ffe-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'df84b152-0000-4000-a000-000000000001', 'source_control')
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
  ('6b5c0bb8-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', '${secret1Key}', 'Synthetic Integration API Key', 'active', 'local_encrypted'),
  ('6b5c0bb8-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', '${secret2Key}', 'Synthetic DB Password', 'active', 'local_encrypted')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "company_secret_versions" (
  "id", "secret_id", "version", "material", "value_sha256", "fingerprint_sha256", "status"
) VALUES
  ('19ea90cd-0000-4000-a000-000000000001', '6b5c0bb8-0000-4000-a000-000000000001', 1, '${JSON.stringify(encryptedMaterial1)}'::jsonb, '${secret1Sha256}', '${secret1Sha256}', 'current'),
  ('19ea90cd-0000-4000-a000-000000000002', '6b5c0bb8-0000-4000-a000-000000000002', 1, '${JSON.stringify(encryptedMaterial2)}'::jsonb, '${secret2Sha256}', '${secret2Sha256}', 'current')
ON CONFLICT ("id") DO NOTHING;

-- 12. Assets & Issue Attachments
INSERT INTO "assets" (
  "id", "company_id", "provider", "object_key", "content_type", "byte_size", "sha256", "original_filename"
) VALUES
  ('6d034d46-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', 'local_disk', '${files[0].objectKey}', 'text/markdown', ${files[0].byteSize}, '${files[0].sha256}', '${path.basename(files[0].objectKey)}'),
  ('6d034d46-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', 'local_disk', '${files[1].objectKey}', 'text/plain', ${files[1].byteSize}, '${files[1].sha256}', '${path.basename(files[1].objectKey)}')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "issue_attachments" ("id", "company_id", "issue_id", "asset_id") VALUES
  ('0dd7f2fe-0000-4000-a000-000000000001', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000001', '6d034d46-0000-4000-a000-000000000001'),
  ('0dd7f2fe-0000-4000-a000-000000000002', 'c0000000-0000-4000-a000-000000000001', '57fdbf2f-0000-4000-a000-000000000002', '6d034d46-0000-4000-a000-000000000002')
ON CONFLICT ("id") DO NOTHING;
`;

  return {
    sql,
    secret1: { key: secret1Key, plaintext: secret1Plaintext, sha256: secret1Sha256 },
    secret2: { key: secret2Key, plaintext: secret2Plaintext, sha256: secret2Sha256 },
  };
}

export function generateVendorGapsSeedSql(releaseTag) {
  let sql = "";

  if (releaseTag === "v2026.1001.0" || releaseTag === "v2026.1005.0" || releaseTag === "v2026.1012.0") {
    // 1001.0+: chat_endpoints + chat_github_reviews
    sql += `
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
`;
  }

  if (releaseTag === "v2026.1005.0" || releaseTag === "v2026.1012.0") {
    // 1005.0+: browser_use_sessions + browser_use_runs
    sql += `
-- Vendor-only table: browser_use_runs (present in 1005.0+)
INSERT INTO "browser_use_sessions" (
  "id", "company_id", "issue_id", "agent_id", "connection_id", "grant_id", "status"
) VALUES (
  'a19b60d8-0000-4000-a000-000000000001',
  'c0000000-0000-4000-a000-000000000001',
  '57fdbf2f-0000-4000-a000-000000000001',
  'a0000000-0000-4000-a000-000000000001',
  'df84b152-0000-4000-a000-000000000001',
  '58bf8ffe-0000-4000-a000-000000000001',
  'active'
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "browser_use_runs" (
  "id", "company_id", "session_id", "heartbeat_run_id", "invocation_id", "status"
) VALUES (
  '0c66d202-0000-4000-a000-000000000001',
  'c0000000-0000-4000-a000-000000000001',
  'a19b60d8-0000-4000-a000-000000000001',
  '7e7aa34f-0000-4000-a000-000000000001',
  'inv-001',
  'completed'
) ON CONFLICT ("id") DO NOTHING;
`;
  }

  if (releaseTag === "v2026.1012.0") {
    // 1012.0+: mcp_oauth_clients + mcp_oauth_grants + mcp_oauth_tokens
    sql += `
-- Vendor-only table: mcp_oauth_tokens (present in 1012.0+)
INSERT INTO "mcp_oauth_clients" (
  "id", "name", "redirect_uris"
) VALUES (
  'client-synth-1',
  'Synth MCP Client',
  '["https://example.com/oauth/callback"]'::jsonb
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "mcp_oauth_grants" (
  "id", "company_id", "user_id", "client_id", "resource", "scopes"
) VALUES (
  'f3e7b926-0000-4000-a000-000000000001',
  'c0000000-0000-4000-a000-000000000001',
  '341041ea-0000-4000-a000-000000000001',
  'client-synth-1',
  'https://example.com/api',
  '["read","write"]'::jsonb
) ON CONFLICT ("id") DO NOTHING;

INSERT INTO "mcp_oauth_tokens" (
  "id", "grant_id", "token_hash", "kind", "expires_at"
) VALUES (
  'e104c878-0000-4000-a000-000000000001',
  'f3e7b926-0000-4000-a000-000000000001',
  'synth-token-hash-42',
  'access',
  now() + interval '1 day'
) ON CONFLICT ("id") DO NOTHING;
`;
  }

  return sql;
}

export function sliceCanonicalSchema(canonicalText, lastTag) {
  const marker = `-- >>> Migration: ${lastTag}.sql <<<`;
  const idx = canonicalText.indexOf(marker);
  if (idx === -1) {
    throw new Error(`Migration marker for ${lastTag} not found in canonical schema.`);
  }
  const nextMarkerIdx = canonicalText.indexOf("-- >>> Migration: ", idx + marker.length);
  return nextMarkerIdx === -1 ? canonicalText : canonicalText.slice(0, nextMarkerIdx);
}

export function generateAllFixtures() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const files = generateStorageFiles();
  const canonicalPath = path.join(FIXTURES_DIR, "schema-paperclip-v2026.1012.0.sql");
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(`Canonical schema file missing at ${canonicalPath}`);
  }
  const canonicalText = fs.readFileSync(canonicalPath, "utf8");

  const baseSeedInfo = generateBaseSeedSql(files, FIXTURE_KEYS);
  const commonSeedPath = path.join(FIXTURES_DIR, "seed-paperclip-synthetic.sql");
  fs.writeFileSync(commonSeedPath, baseSeedInfo.sql, "utf8");

  const generatedReleases = [];

  for (const rel of SUPPORTED_RELEASES) {
    const relDir = path.join(FIXTURES_DIR, "releases", rel.tag);
    fs.mkdirSync(relDir, { recursive: true });

    // 1. Slice schema
    const schemaSql = sliceCanonicalSchema(canonicalText, rel.lastMigration);
    const schemaPathRel = path.join(relDir, "schema.sql");
    const schemaPathRoot = path.join(FIXTURES_DIR, `schema-paperclip-${rel.tag}.sql`);
    fs.writeFileSync(schemaPathRel, schemaSql, "utf8");
    fs.writeFileSync(schemaPathRoot, schemaSql, "utf8");

    // 2. Build seed with vendor gaps
    const gapSql = generateVendorGapsSeedSql(rel.tag);
    const fullSeedSql = baseSeedInfo.sql + gapSql;
    const seedPathRel = path.join(relDir, "seed.sql");
    const seedPathRoot = path.join(FIXTURES_DIR, `seed-paperclip-${rel.tag}.sql`);
    fs.writeFileSync(seedPathRel, fullSeedSql, "utf8");
    fs.writeFileSync(seedPathRoot, fullSeedSql, "utf8");

    // 3. Manifest
    const vendorGapCounts = {};
    if (rel.tag === "v2026.1001.0" || rel.tag === "v2026.1005.0" || rel.tag === "v2026.1012.0") {
      vendorGapCounts.chat_github_reviews = 1;
    }
    if (rel.tag === "v2026.1005.0" || rel.tag === "v2026.1012.0") {
      vendorGapCounts.browser_use_runs = 1;
      vendorGapCounts.browser_use_sessions = 1;
    }
    if (rel.tag === "v2026.1012.0") {
      vendorGapCounts.mcp_oauth_tokens = 1;
      vendorGapCounts.mcp_oauth_grants = 1;
      vendorGapCounts.mcp_oauth_clients = 1;
    }

    const manifest = {
      version: "1.0.0",
      vendorRelease: {
        tag: rel.tag,
        sha: rel.sha,
        lastMigration: rel.lastMigration,
        migrationCount: rel.migrationCount,
      },
      entityCounts: {
        companies: 1,
        projects: 2,
        issues: 3,
        issue_comments: 3,
        documents: 2,
        issue_documents: 2,
        agents: 2,
        instance_settings: 1,
        company_skills: 2,
        tool_connections: 2,
        connection_grants: 1,
        heartbeat_runs: 2,
        company_secrets: 2,
        company_secret_versions: 2,
        assets: 2,
        issue_attachments: 2,
      },
      vendorGapCounts,
      spotChecks: {
        company: {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "Acme Synthetic Robotics",
          issuePrefix: "ACME",
        },
        project: {
          id: "f7f1434e-0000-4000-a000-000000000001",
          name: "Core Platform",
        },
        issue: {
          id: "57fdbf2f-0000-4000-a000-000000000001",
          identifier: "ACME-1",
          title: "Setup initial robotics pipeline",
        },
        agent: {
          id: "a0000000-0000-4000-a000-000000000001",
          name: "synt-lead-agent",
          role: "lead",
        },
        secret: {
          id: "6b5c0bb8-0000-4000-a000-000000000001",
          key: baseSeedInfo.secret1.key,
          expectedPlaintext: baseSeedInfo.secret1.plaintext,
          expectedSha256: baseSeedInfo.secret1.sha256,
        },
        secret2: {
          id: "6b5c0bb8-0000-4000-a000-000000000002",
          key: baseSeedInfo.secret2.key,
          expectedPlaintext: baseSeedInfo.secret2.plaintext,
          expectedSha256: baseSeedInfo.secret2.sha256,
        },
      },
      files,
      keys: FIXTURE_KEYS,
    };

    const manifestPathRel = path.join(relDir, "manifest.json");
    const manifestPathRoot = path.join(FIXTURES_DIR, `manifest-${rel.tag}.json`);
    fs.writeFileSync(manifestPathRel, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(manifestPathRoot, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    // Default root manifest points to the latest release (v2026.1012.0)
    if (rel.tag === "v2026.1012.0") {
      fs.writeFileSync(path.join(FIXTURES_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
      fs.writeFileSync(
        path.join(FIXTURES_DIR, "vendor-release.json"),
        JSON.stringify(
          {
            ...rel,
            compatibilityStatus: "supported_with_vendor_only_reporting",
            summary: "Paperclip v2026.1012.0 is supported by myrmidon:migrate with vendor gap exclusions.",
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
    }

    generatedReleases.push({
      tag: rel.tag,
      schemaPath: schemaPathRoot,
      seedPath: seedPathRoot,
      manifestPath: manifestPathRoot,
      migrationCount: rel.migrationCount,
    });
  }

  // Registry summary
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "vendor-releases.json"),
    JSON.stringify({ supportedReleases: SUPPORTED_RELEASES }, null, 2) + "\n",
    "utf8"
  );

  return generatedReleases;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const list = generateAllFixtures();
  console.log(`Generated synthetic multi-release fixtures for ${list.length} releases:`);
  for (const item of list) {
    console.log(`  - ${item.tag} (${item.migrationCount} migrations): ${item.schemaPath}`);
  }
}
