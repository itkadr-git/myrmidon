// server/src/myrmidon/litellm-audit/redaction.ts
//
// myrmidon(OPE-9857): strict credential and secret redaction for audit logs.
// Credential values are ALWAYS excluded/redacted before persisting or returning
// before/after snapshots and details.

const SECRET_KEY_PATTERN =
  /(^|_|-)(key|api[_-]?key|secret|token|password|credential|auth|bearer|access[_-]?token)($|_|-)/i;

const SECRET_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9_\-]{8,}/i,
  /^pcp_[a-zA-Z0-9_\-]{8,}/i,
  /^ghp_[a-zA-Z0-9_\-]{8,}/i,
  /^bearer\s+[a-zA-Z0-9_\-]{8,}/i,
];

export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Checks whether an object key name represents a credential or sensitive field.
 */
export function isSecretKeyName(keyName: string): boolean {
  return SECRET_KEY_PATTERN.test(keyName);
}

/**
 * Checks whether a string value resembles a secret credential.
 */
export function isSecretStringValue(value: string): boolean {
  if (value.startsWith("«redacted:") || value === REDACTED_PLACEHOLDER) {
    return true;
  }
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Recursively redacts credentials and sensitive attributes from any structure.
 * Guaranteed never to modify the input in-place.
 */
export function redactCredentials<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    if (isSecretStringValue(data)) {
      return REDACTED_PLACEHOLDER as unknown as T;
    }
    return data;
  }

  if (typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactCredentials(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isSecretKeyName(key)) {
      result[key] = REDACTED_PLACEHOLDER;
    } else {
      result[key] = redactCredentials(value);
    }
  }

  return result as T;
}
