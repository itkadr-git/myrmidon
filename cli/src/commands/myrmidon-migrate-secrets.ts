import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CARRIER_SCHEME = "local_encrypted_v1";

export type KeySpec = { file?: string; env?: string };

type Envelope = Record<string, unknown> & { scheme: string; iv: string; tag: string; ciphertext: string };

type SecretProvider = {
  createVersion(input: { value: string }): Promise<{ material: Record<string, unknown> }>;
  resolveVersion(input: { material: Record<string, unknown>; externalRef: string | null }): Promise<string>;
};

let providerPromise: Promise<SecretProvider> | null = null;

/** The existing server provider is the only place that implements the cipher. */
export function loadProvider(): Promise<SecretProvider> {
  providerPromise ??= import("@myrmidonai/server/secrets/local-encrypted-provider").then(
    (mod) => mod.localEncryptedProvider as unknown as SecretProvider,
  );
  return providerPromise;
}

/** Reads a master key from a file or from a named environment variable; never from argv. */
export async function loadKeyMaterial(label: string, spec: KeySpec, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const hasFile = Boolean(spec.file?.trim());
  const hasEnv = Boolean(spec.env?.trim());
  if (hasFile === hasEnv) {
    throw new Error(`Exactly one ${label} key input is required: --${label}-key-file or --${label}-key-env.`);
  }
  let value: string | undefined;
  if (hasFile) {
    try {
      value = (await readFile(spec.file!.trim(), "utf8")).trim();
    } catch {
      throw new Error(`Cannot read the ${label} key file.`);
    }
  } else {
    value = env[spec.env!.trim()]?.trim();
  }
  if (!value) throw new Error(`The ${label} key is empty or the environment variable is not set.`);
  return value;
}

/** Runs fn with the given master key visible to the provider, then restores the environment. */
export async function withMasterKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MYRMIDON_SECRETS_MASTER_KEY;
  process.env.MYRMIDON_SECRETS_MASTER_KEY = key;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MYRMIDON_SECRETS_MASTER_KEY;
    else process.env.MYRMIDON_SECRETS_MASTER_KEY = previous;
  }
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.scheme === CARRIER_SCHEME &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.ciphertext === "string"
  );
}

/** Counts carrier envelopes anywhere inside a JSON value. */
export function countCarriers(value: unknown): number {
  if (isEnvelope(value)) return 1;
  if (Array.isArray(value)) return value.reduce<number>((n, item) => n + countCarriers(item), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>((n, item) => n + countCarriers(item), 0);
  }
  return 0;
}

/** Collects every envelope inside a JSON value. */
export function collectEnvelopes(value: unknown, out: Envelope[] = []): Envelope[] {
  if (isEnvelope(value)) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvelopes(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectEnvelopes(item, out);
  }
  return out;
}

export type { Envelope };

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Replaces every envelope in a JSON value with the result of fn (deep copy). */
export async function mapCarriers(value: unknown, fn: (envelope: Envelope) => Promise<Record<string, unknown>>): Promise<unknown> {
  if (isEnvelope(value)) return fn(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await mapCarriers(item, fn));
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = await mapCarriers(v, fn);
    return out;
  }
  return value;
}

/** Decrypts with the given key and returns the sha256 of the plaintext (plaintext is not retained). */
export async function plaintextHash(key: string, envelope: Envelope): Promise<string> {
  const provider = await loadProvider();
  const plain = await withMasterKey(key, () => provider.resolveVersion({ material: envelope, externalRef: null }));
  return sha256Hex(plain);
}

/** Decrypts with the source key and encrypts with the target key via the existing provider. */
export async function rekeyEnvelope(sourceKey: string, targetKey: string, envelope: Envelope): Promise<Record<string, unknown>> {
  const provider = await loadProvider();
  const plain = await withMasterKey(sourceKey, () => provider.resolveVersion({ material: envelope, externalRef: null }));
  const next = await withMasterKey(targetKey, () => provider.createVersion({ value: plain }));
  return next.material;
}

/** True when the key decrypts the envelope. */
export async function canDecrypt(key: string, envelope: Envelope): Promise<boolean> {
  try {
    await plaintextHash(key, envelope);
    return true;
  } catch {
    return false;
  }
}

/** Validates that a key is usable by the provider (format) without touching any data. */
export async function assertKeyUsable(label: string, key: string): Promise<void> {
  const provider = await loadProvider();
  try {
    const made = await withMasterKey(key, () => provider.createVersion({ value: "myrmidon-migrate-canary" }));
    const back = await withMasterKey(key, () => provider.resolveVersion({ material: made.material, externalRef: null }));
    if (back !== "myrmidon-migrate-canary") throw new Error("canary mismatch");
  } catch {
    throw new Error(`The ${label} key is not a valid secrets master key (expected 32-byte base64, 64-char hex or raw 32-char string).`);
  }
}

/** Replaces every occurrence of the given secret strings in text. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Encrypts a value with the given key through the provider (used by tests and fixtures). */
export async function encryptWithKey(key: string, value: string): Promise<Record<string, unknown>> {
  const provider = await loadProvider();
  return (await withMasterKey(key, () => provider.createVersion({ value }))).material;
}
