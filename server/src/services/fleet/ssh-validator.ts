import { createPrivateKey } from "node:crypto";
import {
  serverOnboardSchema,
  validateSshPrivateKey as validateSharedSshPrivateKey,
  type ServerOnboardInput,
} from "@myrmidon/shared/validators/server-onboard";
import { badRequest } from "../../errors.js";

export type SshPrivateKeyAlgorithm = "rsa" | "ed25519";

export type SshPrivateKeyValidation = {
  valid: boolean;
  algorithm?: SshPrivateKeyAlgorithm;
  error?: string;
};

/** Validate key syntax locally; this function never opens a network connection. */
export function validateSshPrivateKey(privateKey: string): SshPrivateKeyValidation {
  const result = validateSharedSshPrivateKey(privateKey);
  if (!result.valid) return { valid: false, error: result.error };

  if (result.format === "openssh") return { valid: true, algorithm: result.keyType };

  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ed25519") {
      return { valid: false, error: "Only RSA and ED25519 private keys are supported" };
    }
    return { valid: true, algorithm: key.asymmetricKeyType };
  } catch {
    return { valid: false, error: "Private key contains invalid data or is not supported by this runtime" };
  }
}

/** Validate the complete server-onboarding payload; no network calls are made. */
export function validateServerOnboard(input: unknown): {
  success: boolean;
  data?: ServerOnboardInput;
  errors?: string[];
} {
  const parsed = serverOnboardSchema.safeParse(input);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
  return { success: true, data: parsed.data };
}

/** Throw a client error when the server-onboarding payload is invalid. */
export function assertValidServerOnboard(input: unknown): ServerOnboardInput {
  const result = validateServerOnboard(input);
  if (!result.success || !result.data) {
    throw badRequest(result.errors?.join("; ") || "Invalid server onboard parameters");
  }
  return result.data;
}
