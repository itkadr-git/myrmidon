// ---------------------------------------------------------------------------
// OPE-12936 — External-agent task/result envelope + provider capability handshake
// ---------------------------------------------------------------------------
//
// One focused, fail-closed validation path for the external-agent launch
// contract of the ACP engine (`acpx-engine`). It runs BEFORE any provider
// process is spawned and answers exactly three questions:
//
//   1. Is this an envelope this engine understands at all?
//      (`paperclip.external_agent_task.v1` / `paperclip.external_agent_result.v1`)
//      Anything partial, mistyped, or unknown-schema is rejected — the engine
//      never "fills in the gaps" of an invalid envelope.
//   2. Is the requested provider one the engine actually drives? Only the
//      three external-agent providers the engine launches today — Claude Code
//      (`claude`), Codex (`codex`), Gemini CLI (`gemini`) — pass; every other
//      agent id (custom ACP, kimi, grok, unknown names) is rejected as an
//      unsupported provider.
//   3. Does the requested capability set match what that provider's launch
//      path in `execute.ts` really implements? Requests are matched against a
//      capability catalog derived from the per-agent branches in the engine
//      (`fastMode` is Codex-only, `thinkingEffort` is Codex-only via
//      `CODEX_CONFIG`, skills have a distinct mode per provider, and skills
//      for custom agents are tracked-only). An unimplementable combination is
//      rejected up front instead of surfacing later as a provider-side
//      startup failure.
//
// Secrets are handled structurally: the validated task payload is rebuilt
// field-by-field from scalar leaves, so a secret that arrived anywhere in the
// envelope (known secret key names or values that look like credentials) is
// never serialized into the payload the engine forwards.
//
// The catalog intentionally mirrors `execute.ts` only. The runner-side
// sidecar contract (`paperclip-runner`) has its own qualified-profile
// handshake and is out of scope here.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

/** Schema discriminator of the task envelope this module validates. */
export const EXTERNAL_AGENT_TASK_SCHEMA = "paperclip.external_agent_task.v1" as const;
/** Schema discriminator of the result envelope this module validates. */
export const EXTERNAL_AGENT_RESULT_SCHEMA = "paperclip.external_agent_result.v1" as const;

/**
 * The external-agent providers this engine drives, mirroring the per-agent
 * branches in `execute.ts` (`claude` / `codex` / `gemini`). Custom ACP agents
 * (kimi, grok, …) are intentionally absent: they are not external-agent
 * providers and must be rejected by the handshake.
 */
export const EXTERNAL_AGENT_PROVIDERS = ["claude", "codex", "gemini"] as const;
export type ExternalAgentProvider = (typeof EXTERNAL_AGENT_PROVIDERS)[number];

/**
 * The closed set of launch capabilities a task envelope may request. The
 * names mirror the launch-contract knobs the engine applies per agent.
 */
export const EXTERNAL_AGENT_CAPABILITY_KEYS = [
  "persistentSessions",
  "customCommand",
  "mcpServers",
  "remoteSandbox",
  "skills",
  "fastMode",
  "thinkingEffort",
] as const;
export type ExternalAgentCapabilityKey = (typeof EXTERNAL_AGENT_CAPABILITY_KEYS)[number];

/** `skills` is a mode, not a boolean: the engine prepares skills differently per provider. */
export type ExternalAgentSkillsCapability = "supported" | "tracked_only" | "unsupported";

export interface ExternalAgentCapabilities {
  readonly persistentSessions: boolean;
  readonly customCommand: boolean;
  readonly mcpServers: boolean;
  readonly remoteSandbox: boolean;
  readonly skills: ExternalAgentSkillsCapability;
  readonly fastMode: boolean;
  readonly thinkingEffort: boolean;
}

/**
 * Capability catalog derived from the per-agent branches in `execute.ts`:
 * - `fastMode` is applied only when `acpxAgent === "codex"`.
 * - `thinkingEffort` (model_reasoning_effort) is written only into the Codex
 *   startup config.
 * - Skills: Claude gets the settings+bundle runtime, Codex the managed-home
 *   seed, Gemini its own runtime; custom agents are tracked-only.
 * - MCP servers, persistent sessions, custom commands and the remote sandbox
 *   lane are wired for all three providers.
 */
export const EXTERNAL_AGENT_CAPABILITY_CATALOG: Readonly<
  Record<ExternalAgentProvider, ExternalAgentCapabilities>
> = Object.freeze({
  claude: Object.freeze({
    persistentSessions: true,
    customCommand: true,
    mcpServers: true,
    remoteSandbox: true,
    skills: "supported",
    fastMode: false,
    thinkingEffort: false,
  }),
  codex: Object.freeze({
    persistentSessions: true,
    customCommand: true,
    mcpServers: true,
    remoteSandbox: true,
    skills: "supported",
    fastMode: true,
    thinkingEffort: true,
  }),
  gemini: Object.freeze({
    persistentSessions: true,
    customCommand: true,
    mcpServers: true,
    remoteSandbox: true,
    skills: "supported",
    fastMode: false,
    thinkingEffort: false,
  }),
});

/** Stable rejection reasons; callers match on these instead of message text. */
export type ExternalAgentHandshakeRejectionCode =
  | "envelope_invalid"
  | "provider_unsupported"
  | "capability_unsupported"
  | "secret_in_payload";

export interface ExternalAgentHandshakeIssue {
  readonly code: ExternalAgentHandshakeRejectionCode;
  /** JSON-pointer-ish path of the offending envelope field. */
  readonly path: string;
  readonly message: string;
}

export type ExternalAgentHandshakeResult =
  | { ok: true; task: ExternalAgentTask; issues: [] }
  | { ok: false; task: null; issues: ExternalAgentHandshakeIssue[] };

/** Validated task payload — rebuilt field-by-field, secrets can never reach it. */
export interface ExternalAgentTask {
  readonly schema: typeof EXTERNAL_AGENT_TASK_SCHEMA;
  readonly provider: ExternalAgentProvider;
  readonly taskId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly workMode: string | null;
  readonly capabilities: ExternalAgentCapabilities;
}

/** Validated result envelope fields. */
export interface ExternalAgentResult {
  readonly schema: typeof EXTERNAL_AGENT_RESULT_SCHEMA;
  readonly provider: ExternalAgentProvider;
  readonly taskId: string;
  readonly status: "completed" | "failed" | "cancelled" | "blocked";
  readonly summary: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type ExternalAgentResultValidationResult =
  | { ok: true; result: ExternalAgentResult; issues: [] }
  | { ok: false; result: null; issues: ExternalAgentHandshakeIssue[] };

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

/**
 * Key names whose value is treated as a secret wherever they appear in the
 * envelope. Compared in normalized form (lowercase, non-alphanumerics
 * stripped): `PAPERCLIP_API_KEY` arrives as `paperclipapikey`. The list is
 * the generic credential vocabulary plus the well-known provider key env
 * names the engine itself keeps out of logs.
 */
const SECRET_KEY_NAMES = new Set([
  // Generic credential vocabulary (normalized).
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "cookie",
  "password",
  "privatekey",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  // Well-known provider/runtime credential env names (normalized).
  "anthropicapikey",
  "claudeapikey",
  "codexapikey",
  "openaiapikey",
  "geminiapikey",
  "googleapikey",
  "grokapikey",
  "kimiapikey",
  "paperclipapikey",
]);

/** Value shapes that are credentials regardless of the key they arrived under. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^pcp_[A-Za-z0-9_-]+$/, // Paperclip API keys
  /^(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}$/, // sk-…/pk-… style provider keys
  /^(?:Bearer|Basic)\s+\S+$/i, // Authorization header values
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack tokens
];

function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""));
}

function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return false;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * True when a leaf value must never be serialized into the task payload.
 * Exported for tests; production callers use `validateExternalAgentTask`.
 */
export function isExternalAgentSecretLeaf(key: string, value: unknown): boolean {
  if (isSecretKeyName(key)) return true;
  return typeof value === "string" && looksLikeSecretValue(value);
}

/** Stable digest of a rejected secret value for safe diagnostics. */
function secretDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Primitive readers (fail-closed: wrong shape → issue, never a guess)
// ---------------------------------------------------------------------------

function issue(
  code: ExternalAgentHandshakeRejectionCode,
  path: string,
  message: string,
): ExternalAgentHandshakeIssue {
  return { code, path, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return readNonEmptyString(value);
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

function isExternalAgentProvider(value: string): value is ExternalAgentProvider {
  return (EXTERNAL_AGENT_PROVIDERS as readonly string[]).includes(value);
}

function validateProvider(value: unknown, path: string): ExternalAgentHandshakeIssue | ExternalAgentProvider {
  if (typeof value !== "string") {
    return issue("envelope_invalid", path, "provider must be a non-empty string");
  }
  if (!isExternalAgentProvider(value)) {
    return issue(
      "provider_unsupported",
      path,
      `provider ${JSON.stringify(value)} is not a supported external agent; supported: ${EXTERNAL_AGENT_PROVIDERS.join(", ")}`,
    );
  }
  return value;
}

function validateCapabilities(
  value: unknown,
): { capabilities: ReadonlyMap<ExternalAgentCapabilityKey, boolean> } | { issues: ExternalAgentHandshakeIssue[] } {
  const record = asRecord(value);
  if (record === null) {
    return {
      issues: [issue("envelope_invalid", "/capabilities", "capabilities must be an object")],
    };
  }
  const issues: ExternalAgentHandshakeIssue[] = [];
  const requested = new Map<ExternalAgentCapabilityKey, boolean>();
  for (const key of EXTERNAL_AGENT_CAPABILITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const entry = asRecord(record[key]);
    if (entry === null || typeof entry.required !== "boolean") {
      issues.push(
        issue(
          "envelope_invalid",
          `/capabilities/${key}`,
          `${key} must be an object with a boolean "required" field`,
        ),
      );
      continue;
    }
    requested.set(key, entry.required);
  }
  if (requested.size === 0) {
    issues.push(
      issue("envelope_invalid", "/capabilities", "capabilities must declare at least one capability"),
    );
  }
  for (const key of Object.keys(record)) {
    if (!(EXTERNAL_AGENT_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      issues.push(issue("envelope_invalid", `/capabilities/${key}`, "unknown capability"));
    }
  }
  if (issues.length > 0) return { issues };
  return { capabilities: requested };
}

function capabilityUnsupported(
  provider: ExternalAgentProvider,
  key: ExternalAgentCapabilityKey,
): ExternalAgentHandshakeIssue {
  return issue(
    "capability_unsupported",
    `/capabilities/${key}`,
    `provider ${provider} does not support ${key}`,
  );
}

function matchCapabilities(
  provider: ExternalAgentProvider,
  requested: ReadonlyMap<ExternalAgentCapabilityKey, boolean>,
): ExternalAgentHandshakeIssue[] {
  const catalog = EXTERNAL_AGENT_CAPABILITY_CATALOG[provider];
  const issues: ExternalAgentHandshakeIssue[] = [];
  for (const [key, required] of requested) {
    if (!required) continue; // optional capability the caller does not need
    const supported = catalog[key];
    const ok =
      key === "skills"
        ? typeof supported === "string" && supported !== "unsupported"
        : supported === true;
    if (!ok) issues.push(capabilityUnsupported(provider, key));
  }
  return issues;
}

/** Scan every leaf of an unknown structure; report (never copy) secret material. */
function collectSecretIssues(value: unknown, path: string, issues: ExternalAgentHandshakeIssue[]): void {
  const record = asRecord(value);
  if (record !== null) {
    for (const [key, child] of Object.entries(record)) {
      const childPath = `${path}/${key}`;
      if (isExternalAgentSecretLeaf(key, child)) {
        issues.push(
          issue(
            "secret_in_payload",
            childPath,
            `secret material must never be serialized in the task payload (digest ${secretDigest(
              typeof child === "string" ? child : JSON.stringify(child) ?? "",
            )})`,
          ),
        );
        continue;
      }
      collectSecretIssues(child, childPath, issues);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectSecretIssues(child, `${path}/${index}`, issues));
  }
}

/**
 * Validate the external-agent task envelope and negotiate the provider
 * capability handshake in one fail-closed pass.
 *
 * Rejection contract:
 * - partial/invalid envelope → `envelope_invalid`
 * - provider outside {claude, codex, gemini} → `provider_unsupported`
 * - capability the provider's launch path cannot satisfy → `capability_unsupported`
 * - secret-like material anywhere in the envelope → `secret_in_payload`
 *   (the value is never copied into the result; only a short digest is kept)
 */
export function validateExternalAgentTask(value: unknown): ExternalAgentHandshakeResult {
  const envelope = asRecord(value);
  if (envelope === null) {
    return {
      ok: false,
      task: null,
      issues: [issue("envelope_invalid", "/", "task envelope must be a JSON object")],
    };
  }

  const issues: ExternalAgentHandshakeIssue[] = [];

  if (envelope.schema !== EXTERNAL_AGENT_TASK_SCHEMA) {
    issues.push(
      issue(
        "envelope_invalid",
        "/schema",
        `schema must be ${EXTERNAL_AGENT_TASK_SCHEMA}`,
      ),
    );
  }

  const providerOrIssue = validateProvider(envelope.provider, "/provider");
  let provider: ExternalAgentProvider | null = null;
  if (typeof providerOrIssue === "string") {
    provider = providerOrIssue;
  } else {
    issues.push(providerOrIssue);
  }

  const taskId = readNonEmptyString(envelope.taskId);
  if (taskId === null) {
    issues.push(issue("envelope_invalid", "/taskId", "taskId must be a non-empty string"));
  }
  if (typeof taskId === "string" && taskId.length > 200) {
    issues.push(issue("envelope_invalid", "/taskId", "taskId exceeds 200 characters"));
  }

  const prompt = readNonEmptyString(envelope.prompt);
  if (prompt === null) {
    issues.push(issue("envelope_invalid", "/prompt", "prompt must be a non-empty string"));
  }

  const cwd = readNonEmptyString(envelope.cwd);
  if (cwd === null) {
    issues.push(issue("envelope_invalid", "/cwd", "cwd must be a non-empty string"));
  }

  let requestedCapabilities: ReadonlyMap<ExternalAgentCapabilityKey, boolean> | null = null;
  const capabilityCheck = validateCapabilities(envelope.capabilities);
  if ("issues" in capabilityCheck) {
    issues.push(...capabilityCheck.issues);
  } else {
    requestedCapabilities = capabilityCheck.capabilities;
  }

  // model/workMode are optional strings when present.
  for (const [key, reader] of [
    ["model", readOptionalString],
    ["workMode", readOptionalString],
  ] as const) {
    if (envelope[key] === undefined || envelope[key] === null) continue;
    if (reader(envelope[key]) === null) {
      issues.push(issue("envelope_invalid", `/${key}`, `${key} must be a string when present`));
    }
  }

  // Secrets anywhere in the envelope fail the handshake before launch.
  collectSecretIssues(envelope, "", issues);

  if (issues.length > 0) return { ok: false, task: null, issues };
  if (provider === null || taskId === null || prompt === null || cwd === null) {
    // Unreachable in practice (every null co-occurs with an issue above);
    // kept so the narrowing is honest to the compiler.
    return { ok: false, task: null, issues: [issue("envelope_invalid", "/", "task envelope is incomplete")] };
  }

  // Capability negotiation runs only on an otherwise-valid envelope.
  if (requestedCapabilities === null) {
    return { ok: false, task: null, issues: [issue("envelope_invalid", "/capabilities", "capabilities are invalid")] };
  }
  const negotiation = matchCapabilities(provider, requestedCapabilities);
  if (negotiation.length > 0) return { ok: false, task: null, issues: negotiation };

  return {
    ok: true,
    issues: [],
    task: {
      schema: EXTERNAL_AGENT_TASK_SCHEMA,
      provider,
      taskId,
      prompt,
      cwd,
      model: readOptionalString(envelope.model),
      workMode: readOptionalString(envelope.workMode),
      capabilities: { ...EXTERNAL_AGENT_CAPABILITY_CATALOG[provider] },
    },
  };
}

/**
 * Validate an external-agent result envelope with the same fail-closed
 * contract. A terminal result must state its provider, task binding, and a
 * known terminal status; failed results must carry a bounded error identity.
 */
export function validateExternalAgentResult(value: unknown): ExternalAgentResultValidationResult {
  const envelope = asRecord(value);
  if (envelope === null) {
    return {
      ok: false,
      result: null,
      issues: [issue("envelope_invalid", "/", "result envelope must be a JSON object")],
    };
  }

  const issues: ExternalAgentHandshakeIssue[] = [];

  if (envelope.schema !== EXTERNAL_AGENT_RESULT_SCHEMA) {
    issues.push(
      issue(
        "envelope_invalid",
        "/schema",
        `schema must be ${EXTERNAL_AGENT_RESULT_SCHEMA}`,
      ),
    );
  }

  const providerOrIssue = validateProvider(envelope.provider, "/provider");
  let provider: ExternalAgentProvider | null = null;
  if (typeof providerOrIssue === "string") {
    provider = providerOrIssue;
  } else {
    issues.push(providerOrIssue);
  }

  const taskId = readNonEmptyString(envelope.taskId);
  if (taskId === null) {
    issues.push(issue("envelope_invalid", "/taskId", "taskId must be a non-empty string"));
  }

  const status = readNonEmptyString(envelope.status);
  const terminalStatuses = ["completed", "failed", "cancelled", "blocked"] as const;
  type TerminalStatus = (typeof terminalStatuses)[number];
  const parsedStatus =
    status !== null && (terminalStatuses as readonly string[]).includes(status)
      ? (status as TerminalStatus)
      : null;
  if (parsedStatus === null) {
    issues.push(
      issue(
        "envelope_invalid",
        "/status",
        `status must be one of ${terminalStatuses.join(", ")}`,
      ),
    );
  }

  const summary = readOptionalString(envelope.summary);
  if (summary !== null && summary.length > 8192) {
    issues.push(issue("envelope_invalid", "/summary", "summary exceeds 8192 characters"));
  }

  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  if (parsedStatus === "failed") {
    const error = asRecord(envelope.error);
    if (error === null) {
      issues.push(issue("envelope_invalid", "/error", "a failed result requires an error object"));
    } else {
      errorCode = readNonEmptyString(error.code);
      errorMessage = readOptionalString(error.message);
      if (errorCode === null) {
        issues.push(issue("envelope_invalid", "/error/code", "error.code must be a non-empty string"));
      }
    }
  }

  if (issues.length > 0) return { ok: false, result: null, issues };
  if (provider === null || taskId === null || parsedStatus === null) {
    return { ok: false, result: null, issues: [issue("envelope_invalid", "/", "result envelope is incomplete")] };
  }

  return {
    ok: true,
    issues: [],
    result: {
      schema: EXTERNAL_AGENT_RESULT_SCHEMA,
      provider,
      taskId,
      status: parsedStatus,
      summary,
      errorCode,
      errorMessage,
    },
  };
}

