import type { EnvSecretRefBinding, PluginConfigValidationResult } from "@paperclipai/plugin-sdk";
import { parseRules, validateRules, type MailSortRule } from "./rules.js";

export interface MailPluginConfig {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  username: string;
  passwordSecretRef: EnvSecretRefBinding;
  sourceFolder: string;
  sortRules: MailSortRule[];
  defaultTargetFolder?: string;
  maxMessagesPerRun: number;
}

export type ResolvedConfig =
  | { ok: true; config: MailPluginConfig }
  | { ok: false; errors: string[] };

const DEFAULT_PORT = 993;
const DEFAULT_SOURCE_FOLDER = "INBOX";
const DEFAULT_MAX_MESSAGES = 50;
const HARD_MAX_MESSAGES = 500;

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "secret_ref" && typeof candidate.secretId === "string" && candidate.secretId.length > 0
  );
}

export function resolveConfig(raw: Record<string, unknown>): ResolvedConfig {
  const errors: string[] = [];

  const imapHost = typeof raw.imapHost === "string" ? raw.imapHost.trim() : "";
  if (!imapHost) errors.push("imapHost is required");

  const imapPortRaw = raw.imapPort;
  const imapPort =
    typeof imapPortRaw === "number" && Number.isInteger(imapPortRaw) && imapPortRaw > 0 && imapPortRaw < 65536
      ? imapPortRaw
      : DEFAULT_PORT;

  const imapTls = typeof raw.imapTls === "boolean" ? raw.imapTls : true;

  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  if (!username) errors.push("username is required");

  if (!isSecretRef(raw.passwordSecretRef)) {
    errors.push('passwordSecretRef must be a secret_ref object ({ type: "secret_ref", secretId })');
  }

  const sourceFolder =
    typeof raw.sourceFolder === "string" && raw.sourceFolder.trim() ? raw.sourceFolder.trim() : DEFAULT_SOURCE_FOLDER;

  const maxRaw = raw.maxMessagesPerRun;
  const maxMessagesPerRun =
    typeof maxRaw === "number" && Number.isInteger(maxRaw) && maxRaw > 0
      ? Math.min(maxRaw, HARD_MAX_MESSAGES)
      : DEFAULT_MAX_MESSAGES;

  const defaultTargetFolder =
    typeof raw.defaultTargetFolder === "string" && raw.defaultTargetFolder.trim()
      ? raw.defaultTargetFolder.trim()
      : undefined;

  errors.push(...validateRules(raw.sortRules));

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      imapHost,
      imapPort,
      imapTls,
      username,
      passwordSecretRef: raw.passwordSecretRef as EnvSecretRefBinding,
      sourceFolder,
      sortRules: parseRules(raw.sortRules),
      defaultTargetFolder,
      maxMessagesPerRun,
    },
  };
}

export async function validateConfigDetailed(
  config: Record<string, unknown>,
): Promise<PluginConfigValidationResult> {
  const resolved = resolveConfig(config);
  if (!resolved.ok) {
    return { ok: false, errors: resolved.errors };
  }
  return { ok: true };
}
