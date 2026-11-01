import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { maskEnvValue } from "../commands/env.js";

describe("maskEnvValue", () => {
  it("masks password in postgres database URL while preserving username, host, and port", () => {
    const raw = "postgres://myuser:test_secret_db_pass@db.internal.example.com:5432/paperclip_prod";
    const masked = maskEnvValue("DATABASE_URL", raw);
    expect(masked).toBe("postgres://myuser:" + "***" + "@db.internal.example.com:5432/paperclip_prod");
    expect(masked).not.toContain("test_secret_db_pass");
  });

  it("masks password in connection string format", () => {
    const raw = "Host=db.internal;Port=5432;Database=paperclip;Username=app;Password=test_secret_pass;";
    const masked = maskEnvValue("DATABASE_URL", raw);
    expect(masked).toBe("Host=db.internal;Port=5432;Database=paperclip;Username=app;Password=***;");
    expect(masked).not.toContain("test_secret_pass");
  });

  it("leaves URLs without passwords unchanged", () => {
    const raw = "postgres://localhost:5432/paperclip_dev";
    const masked = maskEnvValue("DATABASE_URL", raw);
    expect(masked).toBe(raw);
  });

  it("masks secret and token variables completely", () => {
    expect(maskEnvValue("PAPERCLIP_AGENT_JWT_SECRET", "test_jwt_secret_token")).toBe("***");
    expect(maskEnvValue("BETTER_AUTH_SECRET", "test_auth_secret_token")).toBe("***");
    expect(maskEnvValue("OPENAI_API_KEY", "test_openai_key")).toBe("***");
    expect(maskEnvValue("ANTHROPIC_API_KEY", "test_anthropic_key")).toBe("***");
    expect(maskEnvValue("AWS_SECRET_ACCESS_KEY", "test_aws_secret_key")).toBe("***");
    expect(maskEnvValue("PAPERCLIP_SECRETS_MASTER_KEY", "test_master_key_val")).toBe("***");
    expect(maskEnvValue("CUSTOM_API_TOKEN", "test_bearer_token")).toBe("***");
    expect(maskEnvValue("ADMIN_PASSWORD", "test_admin_password")).toBe("***");
  });

  it("does not mask non-secret variables, paths, and IDs", () => {
    expect(maskEnvValue("AWS_ACCESS_KEY_ID", "dummy-access-key-id")).toBe("dummy-access-key-id");
    expect(maskEnvValue("PAPERCLIP_STORAGE_PROVIDER", "local_disk")).toBe("local_disk");
    expect(maskEnvValue("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "/etc/paperclip/master.key")).toBe("/etc/paperclip/master.key");
    expect(maskEnvValue("PORT", "3100")).toBe("3100");
    expect(maskEnvValue("PAPERCLIP_PUBLIC_URL", "https://board.example.com")).toBe("https://board.example.com");
    expect(maskEnvValue("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "172800")).toBe("172800");
    expect(maskEnvValue("PAPERCLIP_AGENT_JWT_ISSUER", "paperclip")).toBe("paperclip");
  });

  it("handles empty or placeholder values safely", () => {
    expect(maskEnvValue("DATABASE_URL", "")).toBe("");
    expect(maskEnvValue("DATABASE_URL", "<set-this-value>")).toBe("<set-this-value>");
  });
});

describe("container environment diagnostic wrapper (OPE-1177 / OPE-3100)", () => {
  const wrapperScript = resolve(__dirname, "../../../scripts/docker-env-wrapper.sh");

  it("masks sensitive variables in container env output without command arguments", () => {
    const customEnv = {
      ...process.env,
      DATABASE_URL: "postgres://paperclip_app:test_secret_db_pass@db.prod.internal:5432/paperclip",
      BETTER_AUTH_SECRET: "raw_auth_secret_xyz",
      POSTGRES_PASSWORD: "raw_pg_password_abc",
      PAPERCLIP_API_KEY: "raw_api_key_456",
      SAFE_DIAGNOSTIC_VAR: "normal_diagnostic_value",
      PORT: "3100",
    };

    const output = execFileSync(wrapperScript, [], {
      env: customEnv,
      encoding: "utf-8",
    });

    expect(output).toContain("DATABASE_URL=postgres://paperclip_app:***@db.prod.internal:5432/paperclip");
    expect(output).toContain("BETTER_AUTH_SECRET=***");
    expect(output).toContain("POSTGRES_PASSWORD=***");
    expect(output).toContain("PAPERCLIP_API_KEY=***");
    expect(output).toContain("SAFE_DIAGNOSTIC_VAR=normal_diagnostic_value");
    expect(output).toContain("PORT=3100");

    // Verify raw secret values count is exactly 0
    expect(output).not.toContain("test_secret_db_pass");
    expect(output).not.toContain("raw_auth_secret_xyz");
    expect(output).not.toContain("raw_pg_password_abc");
    expect(output).not.toContain("raw_api_key_456");
  });

  it("delegates to real env transparently when command arguments are provided", () => {
    const output = execFileSync(wrapperScript, ["echo", "test-command-execution"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("test-command-execution");
  });

  it("satisfies diagnostic criteria: piped to sed 's/(_URL=).*/\\1***/' outputs DATABASE_URL=***", () => {
    const customEnv = {
      ...process.env,
      DATABASE_URL: "postgres://paperclip_app:test_secret_db_pass@db.prod.internal:5432/paperclip",
      POSTGRES_PASSWORD: "raw_pg_password_abc",
    };

    const envOutput = execFileSync(wrapperScript, [], {
      env: customEnv,
      encoding: "utf-8",
    });

    const lines = envOutput.split("\n");
    const dbLines = lines.filter((l) => /DATABASE|PG|POSTGRES/i.test(l));

    // Pipe through sed -E 's/(_URL=).*/\1***/'
    const sedProcessed = execFileSync("sed", ["-E", "s/(_URL=).*$/\\1***/"], {
      input: dbLines.join("\n"),
      encoding: "utf-8",
    });

    expect(sedProcessed).toContain("DATABASE_URL=***");
    expect(sedProcessed).toContain("POSTGRES_PASSWORD=***");
    expect(sedProcessed).not.toContain("test_secret_db_pass");
    expect(sedProcessed).not.toContain("raw_pg_password_abc");
  });
});
