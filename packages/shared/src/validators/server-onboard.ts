import { z } from "zod";

/**
 * Base64 character table and reverse lookup for dependency-free decoding.
 * Pure TypeScript implementation that runs safely in browser and node environments.
 */
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

/**
 * Decode a base64 string into a Uint8Array without Buffer or atob dependencies.
 */
export function decodeBase64(input: string): Uint8Array | null {
  const clean = input.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;

  let padding = 0;
  if (clean.endsWith("==")) padding = 2;
  else if (clean.endsWith("=")) padding = 1;

  const byteLength = (clean.length * 3) / 4 - padding;
  const bytes = new Uint8Array(byteLength);

  let byteIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i)]!;
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1)]!;
    const c2 = clean[i + 2] === "=" ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2)]!;
    const c3 = clean[i + 3] === "=" ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3)]!;

    if (c0 < 0 || c1 < 0 || (clean[i + 2] !== "=" && c2 < 0) || (clean[i + 3] !== "=" && c3 < 0)) {
      return null;
    }

    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (byteIdx < byteLength) bytes[byteIdx++] = (triple >> 16) & 0xff;
    if (byteIdx < byteLength) bytes[byteIdx++] = (triple >> 8) & 0xff;
    if (byteIdx < byteLength) bytes[byteIdx++] = triple & 0xff;
  }
  return bytes;
}

/**
 * Validates whether a string is a standard IPv4 address (e.g. 198.51.100.1).
 */
export function isIpv4Address(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const trimmed = ip.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Validates whether a string is a valid IPv6 address (supports standard, compressed, and bracketed formats).
 */
export function isIpv6Address(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const cleaned = ip.trim();
  if (cleaned.startsWith("[") || cleaned.endsWith("]") || cleaned.includes("%")) return false;
  if (!cleaned) return false;
  if ((cleaned.match(/::/g) || []).length > 1) return false;

  // Support IPv4-mapped IPv6 like ::ffff:198.51.100.1
  const lastColon = cleaned.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterLastColon = cleaned.slice(lastColon + 1);
    if (afterLastColon.includes(".")) {
      if (!isIpv4Address(afterLastColon)) return false;
      // An embedded IPv4 address consumes the final two 16-bit groups.
      const prefix = cleaned.slice(0, lastColon);
      const hasCompression = prefix.includes("::");
      const prefixGroups = prefix.replace(/::$/, "").split(":").filter(Boolean);
      if (prefixGroups.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return false;
      return hasCompression ? prefixGroups.length < 6 : prefixGroups.length === 6;
    }
  }

  if (!/^[0-9a-fA-F:]+$/.test(cleaned)) return false;

  const hasDoubleColon = cleaned.includes("::");
  if (hasDoubleColon) {
    const halves = cleaned.split("::");
    if (halves.length !== 2) return false;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    if (left.length + right.length > 7) return false; // compression must replace at least one group
    for (const part of [...left, ...right]) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
    }
    return true;
  } else {
    const parts = cleaned.split(":");
    if (parts.length !== 8) return false;
    for (const part of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
    }
    return true;
  }
}

/**
 * Validates that an IP address is either a valid IPv4 or IPv6 address.
 */
export function isValidIpAddress(ip: string): boolean {
  return isIpv4Address(ip) || isIpv6Address(ip);
}

/**
 * Validates that a port number is an integer in the valid SSH port range 1..65535.
 */
export function isValidSshPort(port: number | string): boolean {
  if (typeof port === "string" && !/^\d+$/.test(port)) return false;
  const value = typeof port === "string" ? Number(port) : port;
  if (!Number.isInteger(value)) return false;
  return value >= 1 && value <= 65535;
}

/**
 * Validates that a username is a valid POSIX/UNIX SSH username.
 */
export function isValidSshUsername(username: string): boolean {
  if (typeof username !== "string") return false;
  const trimmed = username.trim();
  if (trimmed.length < 1 || trimmed.length > 32) return false;
  if (trimmed === "." || trimmed === "..") return false;
  if (trimmed.startsWith("-")) return false;
  return /^[a-zA-Z_][a-zA-Z0-9._-]*$/.test(trimmed);
}

export interface SshPrivateKeyValidationResult {
  valid: boolean;
  format?: "openssh" | "pem";
  keyType?: "rsa" | "ed25519";
  error?: string;
}

function parseDerLength(bytes: Uint8Array, offset: number): { length: number; newOffset: number } | null {
  if (offset >= bytes.length) return null;
  const initial = bytes[offset++]!;
  if (initial < 0x80) return { length: initial, newOffset: offset };
  const numOctets = initial & 0x7f;
  if (numOctets === 0 || numOctets > 4 || offset + numOctets > bytes.length) return null;
  let len = 0;
  for (let i = 0; i < numOctets; i++) {
    len = (len << 8) | bytes[offset++]!;
  }
  return { length: len, newOffset: offset };
}

function parsePkcs1Rsa(bytes: Uint8Array): SshPrivateKeyValidationResult {
  if (bytes.length < 10) return { valid: false, error: "RSA private key is too short" };
  if (bytes[0] !== 0x30) return { valid: false, error: "Invalid ASN.1 DER sequence for RSA private key" };
  const seqLen = parseDerLength(bytes, 1);
  if (!seqLen || seqLen.newOffset + seqLen.length !== bytes.length) {
    return { valid: false, error: "Corrupted ASN.1 sequence length in RSA private key" };
  }
  let offset = seqLen.newOffset;
  // Version INTEGER
  if (bytes[offset++] !== 0x02) return { valid: false, error: "Missing version in RSA private key" };
  const vLen = parseDerLength(bytes, offset);
  if (!vLen || vLen.newOffset + vLen.length > bytes.length) return { valid: false, error: "Invalid version length in RSA private key" };
  offset = vLen.newOffset + vLen.length;
  // Modulus INTEGER
  if (bytes[offset++] !== 0x02) return { valid: false, error: "Missing modulus in RSA private key" };
  const mLen = parseDerLength(bytes, offset);
  if (!mLen || mLen.newOffset + mLen.length > bytes.length || mLen.length < 64) return { valid: false, error: "RSA modulus is too short or invalid" };
  const rsaFields = [] as Uint8Array[];
  let fieldOffset = mLen.newOffset;
  for (let index = 0; index < 8; index++) {
    if (bytes[fieldOffset++] !== 0x02) return { valid: false, error: "Corrupted RSA private key parameters" };
    const field = parseDerLength(bytes, fieldOffset);
    if (!field || field.length === 0 || field.newOffset + field.length > bytes.length) {
      return { valid: false, error: "Corrupted RSA private key parameters" };
    }
    rsaFields.push(bytes.slice(field.newOffset, field.newOffset + field.length));
    fieldOffset = field.newOffset + field.length;
  }
  if (fieldOffset !== seqLen.newOffset + seqLen.length) return { valid: false, error: "Unexpected trailing data in RSA private key" };
  if (rsaFields.some((field) => field.every((byte) => byte === 0))) return { valid: false, error: "RSA private key contains empty parameters" };
  return { valid: true, format: "pem", keyType: "rsa" };
}

function parsePkcs8(bytes: Uint8Array): SshPrivateKeyValidationResult {
  if (bytes.length < 10) return { valid: false, error: "PKCS#8 private key is too short" };
  if (bytes[0] !== 0x30) return { valid: false, error: "Invalid ASN.1 DER sequence for PKCS#8 key" };
  const seqLen = parseDerLength(bytes, 1);
  if (!seqLen || seqLen.newOffset + seqLen.length !== bytes.length) return { valid: false, error: "Corrupted ASN.1 sequence length in PKCS#8 key" };
  let offset = seqLen.newOffset;
  // Version INTEGER
  if (bytes[offset++] !== 0x02) return { valid: false, error: "Missing version in PKCS#8 key" };
  const vLen = parseDerLength(bytes, offset);
  if (!vLen || vLen.newOffset + vLen.length > bytes.length || vLen.length !== 1 || bytes[vLen.newOffset] !== 0) return { valid: false, error: "Invalid version in PKCS#8 key" };
  offset = vLen.newOffset + vLen.length;

  // AlgorithmIdentifier SEQUENCE
  if (bytes[offset++] !== 0x30) return { valid: false, error: "Missing AlgorithmIdentifier in PKCS#8 key" };
  const algLen = parseDerLength(bytes, offset);
  if (!algLen || algLen.newOffset + algLen.length > bytes.length) {
    return { valid: false, error: "Invalid AlgorithmIdentifier length in PKCS#8 key" };
  }
  const algEnd = algLen.newOffset + algLen.length;
  if (algEnd >= seqLen.newOffset + seqLen.length) return { valid: false, error: "Missing private key payload in PKCS#8 key" };
  let algOffset = algLen.newOffset;
  if (bytes[algOffset++] !== 0x06) return { valid: false, error: "Missing OID in PKCS#8 key" };
  const oidLen = parseDerLength(bytes, algOffset);
  if (!oidLen || oidLen.newOffset + oidLen.length > algLen.newOffset + algLen.length) {
    return { valid: false, error: "Invalid OID length in PKCS#8 key" };
  }
  if (oidLen.newOffset + oidLen.length > algEnd) return { valid: false, error: "Invalid OID length in PKCS#8 key" };
  const oidBytes = bytes.slice(oidLen.newOffset, oidLen.newOffset + oidLen.length);
  const oidHex = Array.from(oidBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rsaParamOffset = oidLen.newOffset + oidLen.length;
  if (oidHex === "2b6570" && rsaParamOffset !== algEnd) return { valid: false, error: "Unexpected parameters for ED25519 private key" };
  if (oidHex === "2a864886f70d010101") {
    if (bytes[rsaParamOffset] !== 0x05 || bytes[rsaParamOffset + 1] !== 0x00) return { valid: false, error: "Invalid RSA AlgorithmIdentifier parameters" };
  }

  const keyTagOffset = algEnd;
  if (bytes[keyTagOffset] !== 0x04) return { valid: false, error: "Missing private key octet string in PKCS#8 key" };
  if (oidHex === "2a864886f70d010101" && algEnd !== rsaParamOffset + 2) return { valid: false, error: "Invalid RSA AlgorithmIdentifier length" };
  const privateKeyLen = parseDerLength(bytes, keyTagOffset + 1);
  if (!privateKeyLen || privateKeyLen.newOffset + privateKeyLen.length !== seqLen.newOffset + seqLen.length || privateKeyLen.newOffset <= keyTagOffset + 1) return { valid: false, error: "Invalid private key payload length in PKCS#8 key" };

  // ED25519 OID: 1.3.101.112 -> 2b6570
  // RSA OID: 1.2.840.113549.1.1.1 -> 2a864886f70d010101
  if (oidHex === "2b6570") {
    const privatePayload = bytes.slice(privateKeyLen.newOffset, privateKeyLen.newOffset + privateKeyLen.length);
    if (privatePayload.length !== 34 || privatePayload[0] !== 0x04 || privatePayload[1] !== 0x20) {
      return { valid: false, error: "Invalid ED25519 private key payload" };
    }
    return { valid: true, format: "pem", keyType: "ed25519" };
  } else if (oidHex === "2a864886f70d010101") {
    const payload = bytes.slice(privateKeyLen.newOffset, privateKeyLen.newOffset + privateKeyLen.length);
    const rsa = parsePkcs1Rsa(payload);
    if (!rsa.valid) return { valid: false, error: "RSA private key payload is invalid" };
    return { valid: true, format: "pem", keyType: "rsa" };
  } else {
    return {
      valid: false,
      error: `Unsupported PKCS#8 algorithm OID: ${oidHex}. Only RSA and ED25519 private keys are supported.`,
    };
  }
}

function parseOpenSsh(bytes: Uint8Array): SshPrivateKeyValidationResult {
  const magic = "openssh-key-v1\0";
  if (bytes.length < magic.length || Array.from(magic).some((c, i) => bytes[i] !== c.charCodeAt(0))) return { valid: false, error: "Invalid OpenSSH key header" };
  let offset = magic.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint = (): number | null => { if (offset + 4 > bytes.length) return null; const n = view.getUint32(offset); offset += 4; return n; };
  const bytesField = (end = bytes.length): Uint8Array | null => { const n = uint(); if (n === null || offset + n > end) return null; const value = bytes.slice(offset, offset + n); offset += n; return value; };
  const string = (): string | null => { const value = bytesField(); return value === null ? null : String.fromCharCode(...value); };
  const cipher = string(); const kdf = string();
  if (cipher === null || kdf === null) return { valid: false, error: "Corrupted OpenSSH key header" };
  if (cipher !== "none" || kdf !== "none") return { valid: false, error: "Encrypted private keys are not supported" };
  const options = uint();
  if (options === null || offset + options > bytes.length) return { valid: false, error: "Corrupted OpenSSH key options" };
  offset += options;
  const keyCount = uint();
  if (keyCount !== 1) return { valid: false, error: "OpenSSH key must contain one private key" };
  const pub = bytesField(); if (!pub || pub.length < 4) return { valid: false, error: "Corrupted OpenSSH public key" };
  const pv = new DataView(pub.buffer, pub.byteOffset, pub.byteLength);
  const typeLength = pv.getUint32(0);
  if (typeLength === 0 || typeLength + 4 > pub.length) return { valid: false, error: "Corrupted OpenSSH key type" };
  const type = String.fromCharCode(...pub.slice(4, 4 + typeLength));
  let pubOffset = 4 + typeLength;
  const publicField = (): Uint8Array | null => {
    if (pubOffset + 4 > pub.length) return null;
    const length = pv.getUint32(pubOffset);
    pubOffset += 4;
    if (pubOffset + length > pub.length) return null;
    const value = pub.slice(pubOffset, pubOffset + length);
    pubOffset += length;
    return value;
  };
  if (type !== "ssh-rsa" && type !== "ssh-ed25519") return { valid: false, error: "Unsupported OpenSSH key type" };
  if (type === "ssh-rsa") {
    const exponent = publicField();
    const modulus = publicField();
    if (!exponent || !modulus || pubOffset !== pub.length) return { valid: false, error: "Corrupted OpenSSH RSA public key" };
  } else {
    const publicBytes = publicField();
    if (!publicBytes || publicBytes.length !== 32 || pubOffset !== pub.length) return { valid: false, error: "Corrupted OpenSSH ED25519 public key" };
  }
  const privateLength = uint();
  if (privateLength === null || offset + privateLength !== bytes.length || privateLength < 8) return { valid: false, error: "Corrupted OpenSSH private key block" };
  const end = offset + privateLength;
  if (view.getUint32(offset) !== view.getUint32(offset + 4)) return { valid: false, error: "OpenSSH key check values do not match" };
  offset += 8;
  const field = (): Uint8Array | null => {
    if (offset + 4 > end) return null;
    const length = view.getUint32(offset);
    offset += 4;
    if (offset + length > end) return null;
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const name = field();
  if (!name || String.fromCharCode(...name) !== type) return { valid: false, error: "OpenSSH public and private key types differ" };
    if (type === "ssh-rsa") {
    const rsaFields: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) {
      const value = field();
      if (!value || value.length === 0) return { valid: false, error: "Corrupted OpenSSH RSA parameters" };
      rsaFields.push(value);
    }
    if (rsaFields[0]!.length < 64) return { valid: false, error: "RSA modulus is too short" };
  } else {
    const pubBytes = field();
    const privateBytes = field();
    if (!pubBytes || pubBytes.length !== 32 || !privateBytes || privateBytes.length !== 64) return { valid: false, error: "Corrupted OpenSSH ED25519 parameters" };
    if (privateBytes[32] !== pubBytes[0]) return { valid: false, error: "OpenSSH ED25519 public and private key data do not match" };
  }
  if (!field()) return { valid: false, error: "Corrupted OpenSSH private key comment" };
  if (type === "ssh-rsa" && pubOffset !== pub.length) return { valid: false, error: "Unexpected data in OpenSSH RSA public key" };
  for (let i = offset; i < end; i++) if (bytes[i] !== ((i - offset + 1) & 0xff)) return { valid: false, error: "Invalid OpenSSH private key padding" };
  return offset <= end ? { valid: true, format: "openssh", keyType: type === "ssh-rsa" ? "rsa" : "ed25519" } : { valid: false, error: "Corrupted OpenSSH private key block" };
}

/**
 * Validates the syntax and structure of an SSH private key without network connectivity.
 * Supports RSA and ED25519 keys in OpenSSH or PEM (PKCS#1 / PKCS#8) format.
 */
export function validateSshPrivateKey(key: string): SshPrivateKeyValidationResult {
  if (typeof key !== "string" || !key.trim()) {
    return { valid: false, error: "SSH private key cannot be empty" };
  }
  const trimmed = key.trim();
  if (trimmed.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----") || trimmed.includes("Proc-Type: 4,ENCRYPTED")) {
    return { valid: false, error: "Encrypted private keys with passphrase are not supported" };
  }

  const normalized = trimmed.replace(/\r/g, "");
  const legacy = normalized.match(/^-----BEGIN (DSA|EC) PRIVATE KEY-----\s+([\s\S]+?)\s+-----END \1 PRIVATE KEY-----$/);
  if (legacy) return { valid: false, error: `Unsupported key algorithm: ${legacy[1] === "EC" ? "ECDSA" : "DSA"}. Only RSA and ED25519 private keys are supported.` };
  const match = normalized.match(/^-----BEGIN ([A-Z0-9 ]+)-----\s+([\s\S]+?)\s+-----END \1-----$/);
  if (match) {
    const label = match[1]!;
    if (label === "OPENSSH PRIVATE KEY") {
      const body = match[2]!;
      const bytes = decodeBase64(body);
      if (!bytes) return { valid: false, error: "Invalid base64 encoding in private key" };
      return parseOpenSsh(bytes);
    }
    if (label === "DSA PRIVATE KEY" || label === "EC PRIVATE KEY") {
      return { valid: false, error: `Unsupported key algorithm: ${label === "EC PRIVATE KEY" ? "ECDSA" : "DSA"}. Only RSA and ED25519 private keys are supported.` };
    }
    if (label === "RSA PRIVATE KEY" || label === "PRIVATE KEY") {
      const body = match[2]!;
      if (!/^[A-Za-z0-9+/=\s]+$/.test(body)) return { valid: false, error: "Invalid base64 encoding in private key" };
      const bytes = decodeBase64(body);
      if (!bytes) return { valid: false, error: "Invalid base64 encoding in private key" };
      return label === "RSA PRIVATE KEY" ? parsePkcs1Rsa(bytes) : parsePkcs8(bytes);
    }
    return { valid: false, error: `Unsupported private key format: ${label}` };
  }

  const keyPattern = /^-----BEGIN (OPENSSH |RSA )?PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END (OPENSSH |RSA )?PRIVATE KEY-----$/;
  const pem = normalized.match(keyPattern);
  if (!pem || pem[1] !== pem[3]) {
    return { valid: false, error: "Invalid or corrupted private key headers/footers. Expected OpenSSH or PEM RSA/ED25519 private key." };
  }
  const bytes = decodeBase64(pem[2]!);
  if (!bytes) return { valid: false, error: "Invalid base64 encoding in private key" };
  if (pem[1] === "OPENSSH ") return parseOpenSsh(bytes);
  if (pem[1] === "RSA ") return parsePkcs1Rsa(bytes);
  return parsePkcs8(bytes);
}

/**
 * Zod schema for SSH host IP address (IPv4 or IPv6).
 */
export const sshIpAddressSchema = z
  .string()
  .trim()
  .min(1, "IP address is required")
  .refine(isValidIpAddress, {
    message: "Invalid IP address: must be a valid IPv4 or IPv6 address",
  });

/**
 * Zod schema for SSH connection port (1..65535, default: 22).
 */
export const sshPortSchema = z.coerce
  .number()
  .int("SSH port must be an integer")
  .min(1, "SSH port must be between 1 and 65535")
  .max(65535, "SSH port must be between 1 and 65535");

/**
 * Zod schema for SSH username.
 */
export const sshUsernameSchema = z
  .string()
  .trim()
  .min(1, "SSH username is required")
  .max(32, "SSH username must not exceed 32 characters")
  .refine(isValidSshUsername, {
    message:
      "Invalid SSH username: must start with a letter or underscore and contain only letters, numbers, underscores, hyphens, and dots (max 32 characters)",
  });

/**
 * Zod schema for SSH private key (OpenSSH or PEM RSA/ED25519).
 */
export const sshPrivateKeySchema = z
  .string()
  .trim()
  .min(1, "SSH private key is required")
  .refine((value) => validateSshPrivateKey(value).valid, {
    message: "Invalid SSH private key",
  });

/**
 * Zod schema for validating the new server onboard connection form parameters.
 */
export const serverOnboardSchema = z.object({
  ip: sshIpAddressSchema,
  port: sshPortSchema.default(22),
  username: sshUsernameSchema,
  privateKey: sshPrivateKeySchema,
});

export type ServerOnboardInput = z.infer<typeof serverOnboardSchema>;

/**
 * Alias for serverOnboardSchema under the sshConnectionParams naming.
 */
export const sshConnectionParamsSchema = serverOnboardSchema;
export type SshConnectionParams = ServerOnboardInput;
