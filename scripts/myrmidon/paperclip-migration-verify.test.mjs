import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeKeyBuffer,
  extractSchemaTables,
  formatReportMarkdown,
  parseSqlDumpCounts,
  sha256Hex,
  tryDecryptSecret,
  verifyMigration,
  verifyReleaseGapsAgainstSchema,
  verifySecretReEncryption,
  verifyStorageFiles,
} from "./paperclip-migration-verify.mjs";

import {
  encryptAes256Gcm,
  FIXTURE_KEYS,
  SUPPORTED_RELEASES,
} from "./paperclip-migration-generate-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../tests/fixtures/paperclip-migration");

describe("Paperclip Migration Verification Suite (Multi-Release)", () => {
  const sourceKeyBuf = decodeKeyBuffer(FIXTURE_KEYS.sourceMasterKeyHex);
  const targetKeyBuf = decodeKeyBuffer(FIXTURE_KEYS.targetMasterKeyHex);

  it("decodes 32-byte hex master keys correctly", () => {
    assert.equal(sourceKeyBuf.length, 32);
    assert.equal(targetKeyBuf.length, 32);
    assert.notDeepEqual(sourceKeyBuf, targetKeyBuf);
  });

  describe("Registry releases fixture verification", () => {
    it("covers all 5 supported releases in the registry", () => {
      const tags = SUPPORTED_RELEASES.map((r) => r.tag);
      assert.deepEqual(tags, [
        "v2026.916.0",
        "v2026.916.1",
        "v2026.1001.0",
        "v2026.1005.0",
        "v2026.1012.0",
      ]);
    });

    for (const rel of SUPPORTED_RELEASES) {
      describe(`Release ${rel.tag}`, () => {
        const schemaPath = path.join(FIXTURES_DIR, `schema-paperclip-${rel.tag}.sql`);
        const seedPath = path.join(FIXTURES_DIR, `seed-paperclip-${rel.tag}.sql`);
        const manifestPath = path.join(FIXTURES_DIR, `manifest-${rel.tag}.json`);

        it(`has canonical schema DDL with exactly ${rel.migrationCount} migrations`, () => {
          assert.ok(fs.existsSync(schemaPath), `schema file exists: ${schemaPath}`);
          const schemaText = fs.readFileSync(schemaPath, "utf8");
          const insertMatches = schemaText.match(/INSERT INTO "drizzle"\."__drizzle_migrations"/g);
          assert.equal(insertMatches ? insertMatches.length : 0, rel.migrationCount);
          assert.ok(schemaText.includes(`-- >>> Migration: ${rel.lastMigration}.sql <<<`));
        });

        it(`has synthetic seed SQL with non-empty entities`, () => {
          assert.ok(fs.existsSync(seedPath), `seed file exists: ${seedPath}`);
          const seedText = fs.readFileSync(seedPath, "utf8");
          assert.ok(seedText.includes(`INSERT INTO "companies"`));
          assert.ok(seedText.includes(`INSERT INTO "projects"`));
          assert.ok(seedText.includes(`INSERT INTO "issues"`));
          assert.ok(seedText.includes(`INSERT INTO "issue_comments"`));
          assert.ok(seedText.includes(`INSERT INTO "documents"`));
          assert.ok(seedText.includes(`INSERT INTO "agents"`));
          assert.ok(seedText.includes(`INSERT INTO "instance_settings"`));
          assert.ok(seedText.includes(`INSERT INTO "company_skills"`));
          assert.ok(seedText.includes(`INSERT INTO "tool_connections"`));
          assert.ok(seedText.includes(`INSERT INTO "heartbeat_runs"`));
          assert.ok(seedText.includes(`INSERT INTO "company_secrets"`));
          assert.ok(seedText.includes(`INSERT INTO "assets"`));
          assert.ok(seedText.includes(`INSERT INTO "issue_attachments"`));
        });

        if (rel.tag === "v2026.1001.0" || rel.tag === "v2026.1005.0" || rel.tag === "v2026.1012.0") {
          it(`seeds rows into vendor gap tables for ${rel.tag} (e.g. chat_github_reviews)`, () => {
            const seedText = fs.readFileSync(seedPath, "utf8");
            assert.ok(seedText.includes(`INSERT INTO "chat_github_reviews"`));
          });
        }

        if (rel.tag === "v2026.1005.0" || rel.tag === "v2026.1012.0") {
          it(`seeds rows into browser_use_runs for ${rel.tag}`, () => {
            const seedText = fs.readFileSync(seedPath, "utf8");
            assert.ok(seedText.includes(`INSERT INTO "browser_use_runs"`));
          });
        }

        if (rel.tag === "v2026.1012.0") {
          it(`seeds rows into mcp_oauth_tokens for ${rel.tag}`, () => {
            const seedText = fs.readFileSync(seedPath, "utf8");
            assert.ok(seedText.includes(`INSERT INTO "mcp_oauth_tokens"`));
          });
        }

        it(`has manifest matching entity counts and spot checks`, () => {
          assert.ok(fs.existsSync(manifestPath), `manifest file exists: ${manifestPath}`);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          assert.equal(manifest.vendorRelease.tag, rel.tag);
          assert.equal(manifest.vendorRelease.migrationCount, rel.migrationCount);
          assert.ok(manifest.entityCounts.companies >= 1);
          assert.ok(manifest.entityCounts.issues >= 1);
          assert.ok(manifest.entityCounts.agents >= 1);
          assert.ok(manifest.entityCounts.company_secrets >= 1);
        });
      });
    }
  });

  describe("Vendor gap report vs canonical database schema (Acceptance Criterion 2)", () => {
    it("proves 1012.0 dry-run gap list is reproducible and matches the 32 actual DB schema tables", () => {
      const schemaPath = path.join(FIXTURES_DIR, "schema-paperclip-v2026.1012.0.sql");
      const schemaText = fs.readFileSync(schemaPath, "utf8");

      // Extract all tables created in 1012.0 canonical schema
      const allTables = extractSchemaTables(schemaText);
      assert.ok(allTables.length > 50, "Schema DDL contains all tables");

      const rel1012 = SUPPORTED_RELEASES.find((r) => r.tag === "v2026.1012.0");
      assert.equal(rel1012.extraTables.length, 32, "1012.0 has exactly 32 vendor-only tables");

      // Verify each of the 32 tables exists in the schema DDL
      const gapCheck = verifyReleaseGapsAgainstSchema(schemaText, rel1012.extraTables);
      assert.equal(gapCheck.valid, true);
      assert.equal(gapCheck.missingTables.length, 0);
      assert.equal(gapCheck.checkedGaps, 32);

      // Verify specific vendor tables mentioned in requirements
      assert.ok(allTables.includes("chat_github_reviews"));
      assert.ok(allTables.includes("browser_use_runs"));
      assert.ok(allTables.includes("mcp_oauth_tokens"));
    });

    it("verifies 1001.0 and 1005.0 gap tables against their respective DDLs", () => {
      for (const tag of ["v2026.1001.0", "v2026.1005.0"]) {
        const schemaPath = path.join(FIXTURES_DIR, `schema-paperclip-${tag}.sql`);
        const schemaText = fs.readFileSync(schemaPath, "utf8");
        const rel = SUPPORTED_RELEASES.find((r) => r.tag === tag);
        const gapCheck = verifyReleaseGapsAgainstSchema(schemaText, rel.extraTables);
        assert.equal(gapCheck.valid, true);
        assert.equal(gapCheck.missingTables.length, 0);
      }
    });

    it("verifies 916.0 and 916.1 have zero vendor-only gaps", () => {
      for (const tag of ["v2026.916.0", "v2026.916.1"]) {
        const rel = SUPPORTED_RELEASES.find((r) => r.tag === tag);
        assert.equal(rel.extraTables.length, 0);
        assert.equal(rel.extraColumns.length, 0);
      }
    });
  });

  describe("Secret carrier re-encryption check", () => {
    const plaintext = "test-secret-payload-token";
    const expectedSha = sha256Hex(plaintext);

    it("passes when material is properly re-encrypted with target key", () => {
      const reEncrypted = encryptAes256Gcm(targetKeyBuf, plaintext);

      const check = verifySecretReEncryption({
        material: reEncrypted,
        sourceKeyBuffer: sourceKeyBuf,
        targetKeyBuffer: targetKeyBuf,
        expectedPlaintext: plaintext,
        expectedSha256: expectedSha,
      });

      assert.equal(check.valid, true);
      assert.equal(check.oldKeyRejected, true);
      assert.equal(check.newKeyAccepted, true);
      assert.equal(check.plaintextMatches, true);
      assert.equal(check.sha256Matches, true);
      assert.equal(check.errors.length, 0);
    });

    it("fails (negative regression) when secret was NOT re-encrypted and still has old key", () => {
      const notReEncrypted = encryptAes256Gcm(sourceKeyBuf, plaintext);

      const check = verifySecretReEncryption({
        material: notReEncrypted,
        sourceKeyBuffer: sourceKeyBuf,
        targetKeyBuffer: targetKeyBuf,
        expectedPlaintext: plaintext,
        expectedSha256: expectedSha,
      });

      assert.equal(check.valid, false);
      assert.equal(check.oldKeyRejected, false);
      assert.ok(check.errors.some((e) => e.includes("Security violation")));
    });

    it("fails when wrong target key is used", () => {
      const wrongTargetKeyBuf = decodeKeyBuffer("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const reEncrypted = encryptAes256Gcm(targetKeyBuf, plaintext);

      const check = verifySecretReEncryption({
        material: reEncrypted,
        sourceKeyBuffer: sourceKeyBuf,
        targetKeyBuffer: wrongTargetKeyBuf,
        expectedPlaintext: plaintext,
        expectedSha256: expectedSha,
      });

      assert.equal(check.valid, false);
      assert.equal(check.newKeyAccepted, false);
      assert.ok(check.errors.some((e) => e.includes("Target master key failed to decrypt")));
    });
  });

  describe("Storage files verification", () => {
    it("verifies fixture files exist and match manifest", () => {
      const manifestPath = path.join(FIXTURES_DIR, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const storageDir = path.join(FIXTURES_DIR, "storage");

      const check = verifyStorageFiles(FIXTURES_DIR, manifest.files);
      assert.equal(check.valid, true);
      assert.equal(check.checked, manifest.files.length);
      assert.equal(check.passed, manifest.files.length);
    });

    it("fails (negative regression) when file size or hash is mismatched", () => {
      const fakeFiles = [
        {
          objectKey: "storage/nonexistent.txt",
          relativePath: "storage/nonexistent.txt",
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          byteSize: 10,
        },
      ];
      const check = verifyStorageFiles(FIXTURES_DIR, fakeFiles);
      assert.equal(check.valid, false);
      assert.ok(check.mismatches.some((m) => m.error.includes("Missing target storage file")));
    });
  });

  describe("End-to-end multi-release verification report", () => {
    it("produces clean pass for valid multi-release migration evidence", () => {
      const manifestPath = path.join(FIXTURES_DIR, "manifest-v2026.1012.0.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      const targetCounts = {
        ...manifest.entityCounts,
      };

      const plain = "synth-token-42-test-api-key-for-migration-proof";
      const targetSecrets = {
        "6b5c0bb8-0000-4000-a000-000000000001": {
          material: encryptAes256Gcm(targetKeyBuf, plain),
          expectedSha256: sha256Hex(plain),
        },
      };

      const report = verifyMigration({
        manifest,
        targetCounts,
        targetStorageDir: FIXTURES_DIR,
        targetSecrets,
        sourceKey: FIXTURE_KEYS.sourceMasterKeyHex,
        targetKey: FIXTURE_KEYS.targetMasterKeyHex,
        sourceUnchanged: true,
        rollbackVerified: true,
      });

      assert.equal(report.status, "pass");
      assert.equal(report.checks.entityCounts.passed, true);
      assert.equal(report.checks.storageFiles.valid, true);
      assert.equal(report.checks.secretReEncryption.passed, true);
      assert.equal(report.checks.sourceUnchanged.passed, true);
      assert.equal(report.checks.rollback.passed, true);

      const md = formatReportMarkdown(report);
      assert.ok(md.includes("**Overall Status:** GREEN (Passed)"));
      assert.ok(md.includes("v2026.1012.0"));
    });

    it("fails with explicit error when an entity count is under-migrated", () => {
      const manifestPath = path.join(FIXTURES_DIR, "manifest-v2026.1001.0.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      const targetCounts = {
        ...manifest.entityCounts,
        issues: 0, // under-migrated!
      };

      const report = verifyMigration({
        manifest,
        targetCounts,
        targetStorageDir: FIXTURES_DIR,
        sourceKey: FIXTURE_KEYS.sourceMasterKeyHex,
        targetKey: FIXTURE_KEYS.targetMasterKeyHex,
      });

      assert.equal(report.status, "fail");
      assert.equal(report.checks.entityCounts.passed, false);
      assert.ok(report.errors.some((e) => e.includes("Entity count verification failed")));
    });
  });
});
