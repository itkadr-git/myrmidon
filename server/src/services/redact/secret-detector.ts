import {
  KNOWN_PREFIX_PATTERNS,
  type SecretPattern,
} from "./patterns.js";

export interface SecretMatch {
  type: string;
  value: string;
  raw: string;
  start: number;
  end: number;
  entropy?: number;
  placeholder: string;
}

export interface SecretDetectorOptions {
  /** Custom patterns to check. Defaults to KNOWN_PREFIX_PATTERNS. */
  patterns?: readonly SecretPattern[];
  /** Shannon entropy threshold for general alphanumeric / base64 candidate strings. Default: 4.2 */
  entropyThreshold?: number;
  /** Shannon entropy threshold for hexadecimal candidate strings. Default: 3.4 */
  hexEntropyThreshold?: number;
  /** Minimum length for entropy check (strings longer than 20 chars without spaces). Default: 21 */
  minEntropyLength?: number;
  /**
   * If true, keeps the "Bearer " scheme word and redacts only the token value.
   * If false (default), redacts the entire "Bearer <token>" string into "<redacted-secret:bearer>".
   */
  preserveBearerScheme?: boolean;
  /** Custom placeholder generator. Default: `<redacted-secret:${type}>` */
  placeholder?: (type: string, match?: Partial<SecretMatch>) => string;
}

const DEFAULT_ENTROPY_THRESHOLD = 4.2;
const DEFAULT_HEX_ENTROPY_THRESHOLD = 3.4;
const DEFAULT_MIN_ENTROPY_LENGTH = 21; // "длиннее 20 символов" -> length >= 21

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URN_UUID_REGEX =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEX_ONLY_REGEX = /^[0-9a-fA-F]+$/;

/**
 * Calculates the Shannon entropy H(X) in bits per character for a given string:
 * H(X) = -sum(P(x) * log2(P(x)))
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Checks whether a candidate string is a standard UUID (v1-v5) or URN UUID.
 * Minimizes false positives on identifiers used throughout Myrmidon/Paperclip.
 */
export function isUuid(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  return UUID_REGEX.test(trimmed) || URN_UUID_REGEX.test(trimmed);
}

/**
 * Checks whether a candidate string represents base64-encoded file data,
 * images, serialized JSON, or human-readable document payloads rather than
 * cryptographic secret keys.
 */
export function isBase64Data(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();

  // 1. Data URI prefix (e.g. data:image/png;base64,...)
  if (/^data:[a-zA-Z0-9+/-]+;base64,/i.test(trimmed)) {
    return true;
  }

  // 2. Must use valid base64 or base64url character set
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    return false;
  }

  // 3. Very long base64 payloads (> 120 chars) are almost invariably
  // encoded assets/files/blobs, not cryptographic tokens/keys.
  if (trimmed.length > 120) {
    return true;
  }

  // 4. Inspect decoded content for magic bytes or structured text
  try {
    const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(normalized, "base64");
    if (buf.length < 4) return false;

    // Known file magic bytes
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    // GIF: GIF8
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
    // PDF: %PDF (25 50 44 46)
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true;
    // ZIP: PK\x03\x04 or PK\x05\x06
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return true;
    // GZIP: 1F 8B
    if (buf[0] === 0x1f && buf[1] === 0x8b) return true;
    // WebP: RIFF ... WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;

    // Check if decodes to printable text with spaces or structured data
    const decodedText = buf.toString("utf8");
    // Printable ASCII text with whitespace (sentences, paragraphs)
    if (decodedText.includes(" ") && /^[\x20-\x7E\r\n\t]+$/.test(decodedText)) {
      return true;
    }

    // JSON object or array payload
    const trimmedDecoded = decodedText.trim();
    if (
      (trimmedDecoded.startsWith("{") && trimmedDecoded.endsWith("}")) ||
      (trimmedDecoded.startsWith("[") && trimmedDecoded.endsWith("]"))
    ) {
      try {
        JSON.parse(trimmedDecoded);
        return true;
      } catch {
        // Not valid JSON
      }
    }

    // XML/HTML document fragments
    if (trimmedDecoded.startsWith("<") && trimmedDecoded.endsWith(">")) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function defaultPlaceholder(type: string): string {
  return `<redacted-secret:${type}>`;
}

/**
 * Scans text for secret tokens matching known prefixes and high-entropy cryptographic keys.
 */
export function detectSecrets(
  text: string,
  options?: SecretDetectorOptions,
): SecretMatch[] {
  if (!text || typeof text !== "string") return [];

  const patterns = options?.patterns ?? KNOWN_PREFIX_PATTERNS;
  const entropyThreshold = options?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
  const hexEntropyThreshold = options?.hexEntropyThreshold ?? DEFAULT_HEX_ENTROPY_THRESHOLD;
  const minEntropyLength = options?.minEntropyLength ?? DEFAULT_MIN_ENTROPY_LENGTH;
  const preserveBearerScheme = options?.preserveBearerScheme ?? false;
  const getPlaceholder = options?.placeholder ?? defaultPlaceholder;

  const matches: SecretMatch[] = [];

  // 1. Scan for known prefix patterns
  for (const pat of patterns) {
    const re = new RegExp(pat.pattern.source, pat.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const fullMatch = m[0];
      const start = m.index;
      const end = start + fullMatch.length;

      // Special handling for Bearer tokens
      if (pat.type === "bearer" && m[1]) {
        const tokenValue = m[1];
        if (preserveBearerScheme) {
          const tokenStart = end - tokenValue.length;
          // Check if token value is already claimed by a specific prefix (e.g. pcp_, ghp_, sk-)
          const innerAlreadyMatched = matches.some(
            (existing) =>
              existing.start === tokenStart && existing.type !== "bearer",
          );
          if (!innerAlreadyMatched) {
            matches.push({
              type: pat.type,
              value: tokenValue,
              raw: tokenValue,
              start: tokenStart,
              end,
              placeholder: getPlaceholder(pat.type),
            });
          }
        } else {
          matches.push({
            type: pat.type,
            value: tokenValue,
            raw: fullMatch,
            start,
            end,
            placeholder: getPlaceholder(pat.type),
          });
        }
      } else {
        matches.push({
          type: pat.type,
          value: fullMatch,
          raw: fullMatch,
          start,
          end,
          placeholder: getPlaceholder(pat.type),
        });
      }
    }
  }

  // 2. Scan for candidate tokens for entropy filter (strings > 20 chars without spaces)
  // Matches tokens composed of alphanumeric chars, base64 chars, and separators,
  // naturally bounded by whitespace, quotes, colons, equals signs, brackets, etc.
  const candidateRegex = /[A-Za-z0-9+/_-]+={0,2}/g;
  let cand: RegExpExecArray | null;

  while ((cand = candidateRegex.exec(text)) !== null) {
    const token = cand[0];
    const start = cand.index;
    const end = start + token.length;

    // Filter by length: strings longer than 20 chars
    if (token.length < minEntropyLength) {
      continue;
    }

    // Skip if already covered by a known prefix match
    const alreadyMatched = matches.some(
      (existing) => start < existing.end && end > existing.start,
    );
    if (alreadyMatched) {
      continue;
    }

    // Criteria 3: Skip UUIDs
    if (isUuid(token)) {
      continue;
    }

    // Criteria 3: Skip Base64 data (images, PDFs, JSON payloads, data URIs)
    if (isBase64Data(token)) {
      continue;
    }

    // Criteria 2: Calculate Shannon entropy
    const entropy = calculateShannonEntropy(token);
    const isHex = HEX_ONLY_REGEX.test(token);
    const threshold = isHex ? hexEntropyThreshold : entropyThreshold;

    if (entropy >= threshold) {
      matches.push({
        type: "entropy",
        value: token,
        raw: token,
        start,
        end,
        entropy,
        placeholder: getPlaceholder("entropy", { entropy, value: token }),
      });
    }
  }

  // 3. Resolve overlaps and sort by appearance
  // Prefer prefix matches over entropy matches, then earlier matches, then longer matches
  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // Non-entropy has priority
    if (a.type !== "entropy" && b.type === "entropy") return -1;
    if (b.type !== "entropy" && a.type === "entropy") return 1;
    return b.raw.length - a.raw.length;
  });

  const resolved: SecretMatch[] = [];
  for (const match of matches) {
    const collides = resolved.some(
      (winner) => match.start < winner.end && winner.start < match.end,
    );
    if (!collides) {
      resolved.push(match);
    }
  }

  return resolved.sort((a, b) => a.start - b.start);
}

/**
 * Checks whether a candidate string has high Shannon entropy consistent with
 * cryptographic random keys or secrets (> 20 chars, no spaces, not UUID/Base64).
 */
export function isHighEntropyString(
  token: string,
  options?: SecretDetectorOptions,
): boolean {
  if (!token || typeof token !== "string") return false;
  const minLength = options?.minEntropyLength ?? DEFAULT_MIN_ENTROPY_LENGTH;
  if (token.length < minLength) return false;
  if (/\s/.test(token)) return false;
  if (isUuid(token)) return false;
  if (isBase64Data(token)) return false;

  const entropy = calculateShannonEntropy(token);
  const isHex = HEX_ONLY_REGEX.test(token);
  const hexThreshold = options?.hexEntropyThreshold ?? DEFAULT_HEX_ENTROPY_THRESHOLD;
  const generalThreshold = options?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
  const threshold = isHex ? hexEntropyThreshold : generalThreshold;

  return entropy >= threshold;
}

/**
 * Replaces detected secret tokens with placeholders: `<redacted-secret:type>`.
 */
export function redactSecrets(
  text: string,
  options?: SecretDetectorOptions,
): string {
  if (!text || typeof text !== "string") return text;

  const matches = detectSecrets(text, options);
  if (matches.length === 0) return text;

  let result = "";
  let cursor = 0;

  for (const match of matches) {
    result += text.slice(cursor, match.start);
    result += match.placeholder;
    cursor = match.end;
  }
  result += text.slice(cursor);

  return result;
}

export const maskSecrets = redactSecrets;

/**
 * Checks whether a single string or token is detected as a secret.
 */
export function isSecret(str: string, options?: SecretDetectorOptions): boolean {
  if (!str || typeof str !== "string") return false;
  const matches = detectSecrets(str, options);
  return matches.some((m) => m.value === str || m.raw === str);
}

/**
 * Class-based interface for configured SecretDetector instances.
 */
export class SecretDetector {
  private options: SecretDetectorOptions;

  constructor(options?: SecretDetectorOptions) {
    this.options = { ...options };
  }

  detect(text: string): SecretMatch[] {
    return detectSecrets(text, this.options);
  }

  redact(text: string): string {
    return redactSecrets(text, this.options);
  }

  isSecret(str: string): boolean {
    return isSecret(str, this.options);
  }

  calculateEntropy(str: string): number {
    return calculateShannonEntropy(str);
  }
}
