// myrmidon(1.7, OPE-4101, SETTINGS-TO-UI E): the read-only "Deployment" status
// block of the System settings tab. It reports which infrastructure
// integrations are configured (and for secrets — only whether the reference is
// set), never the values themselves. All rows come straight from the process
// environment; there is nothing to persist.

export interface DeploymentStatusRow {
  /** Stable row id, e.g. "litellm-base-url". */
  id: string;
  /** Human label shown in the UI. */
  label: string;
  /** The env var backing this row (documentation for the operator). */
  envName: string;
  /** "configured" when the value is present and well-formed, else "not-configured". */
  status: "configured" | "not-configured";
  /** Optional non-secret detail, e.g. the URL host. Never a credential. */
  detail?: string | null;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** URL host for display; null when the value is not an http(s) URL. */
function urlHost(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.host;
  } catch {
    return null;
  }
}

function urlRow(id: string, label: string, envName: string, env: NodeJS.ProcessEnv): DeploymentStatusRow {
  const value = readTrimmed(env, envName);
  const host = urlHost(value);
  return {
    id,
    label,
    envName,
    status: host ? "configured" : "not-configured",
    detail: host,
  };
}

function flagRow(id: string, label: string, envName: string, env: NodeJS.ProcessEnv): DeploymentStatusRow {
  return {
    id,
    label,
    envName,
    status: readTrimmed(env, envName) ? "configured" : "not-configured",
  };
}

/**
 * The deployment status rows. Sockets and paths report presence only; URLs
 * report the host; secret references report presence only (the secret value
 * itself is never read here).
 */
export function readDeploymentStatus(env: NodeJS.ProcessEnv = process.env): DeploymentStatusRow[] {
  return [
    urlRow("litellm-base-url", "LLM gateway (LiteLLM)", "MYRMIDON_LITELLM_BASE_URL", env),
    flagRow("litellm-key-secret", "LLM gateway key (secret ref)", "MYRMIDON_LITELLM_KEY_SECRET", env),
    urlRow("hindsight-api-url", "Memory service (hindsight)", "MYRMIDON_HINDSIGHT_API_URL", env),
    flagRow("hindsight-key-secret", "Memory service key (secret ref)", "MYRMIDON_HINDSIGHT_KEY_SECRET", env),
    urlRow("zabbix-url", "Zabbix server", "MYRMIDON_ZABBIX_URL", env),
    flagRow("zabbix-token-ref", "Zabbix token (secret ref)", "MYRMIDON_ZABBIX_TOKEN_REF", env),
    flagRow("tracing-clickhouse-url", "Tracing ClickHouse", "MYRMIDON_TRACING_CLICKHOUSE_URL", env),
    urlRow("ocr-base-url", "OCR service", "MYRMIDON_OCR_BASE_URL", env),
    flagRow("docker-socket", "Docker socket", "MYRMIDON_BOT_DOCKER_SOCKET", env),
    urlRow("fleet-host-url", "Fleet host (fleetd)", "MYRMIDON_FLEET_HOST_URL", env),
    urlRow("langfuse-base-url", "Langfuse (evals)", "MYRMIDON_EVALS_LANGFUSE_BASE_URL", env),
    flagRow("bot-egress-proxy", "Bot egress proxy", "MYRMIDON_BOT_EGRESS_PROXY", env),
  ];
}
