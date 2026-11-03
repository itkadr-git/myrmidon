import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";
import { URL_CREDENTIAL_MASK } from "../myrmidon/secret-masking.js";

/**
 * Property/regression tests for JSON secret redaction (OPE-10270).
 *
 * A small seeded PRNG drives a structure generator so the cases are
 * deterministic (no new test dependency; the container cannot update the
 * lockfile). Each generated case must satisfy the redaction invariants:
 *   1. secret values never survive anywhere in the serialized output;
 *   2. the JSON shape (keys, arrays, non-secret leaf values) is preserved;
 *   3. re-applying redaction is a no-op (idempotent).
 */

const SECRET_KEYS = [
  "apiKey",
  "api_key",
  "apikey",
  "password",
  "PASSWORD",
  "passwd",
  "secret",
  "client_secret",
  "accessToken",
  "access_token",
  "authToken",
  "AUTH_TOKEN",
  "token",
  "refresh_token",
  "sessionToken",
  "privateKey",
  "private_key",
  "credential",
  "credentials",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const SAFE_KEYS = [
  "name",
  "title",
  "count",
  "enabled",
  "id",
  "span",
  "message",
  "label",
  "schemaVersion",
  "displayName",
  "description",
  "примечание", // unicode key
  "メモ",
] as const;

const UNICODE_SAFE_VALUES = [
  "plain",
  "hello world",
  "http://localhost:3100",
  "paperclip.run-performance-span.v1",
  "значение без секретов 🔒",
  "日本語のテキスト",
  "emoji 🚀🌍✨ tail",
  "résumé café",
  "with\nnewlines\nand\ttabs",
  "",
] as const;

// Distinctive secret values — if any of these appear in the output
// serialization, redaction leaked. Avoid value shapes that the generic
// heuristics legitimately preserve (hostnames, short words, allowlisted
// dotted discriminators); secrets must be opaque and long enough.
const SECRET_VALUES = [
  "sk-test-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "xoxb-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  "hunter2-long-password-value-1234567890",
  // JWT-shaped value assembled at runtime so the literal source does not
  // match secret-scanning rules (gitleaks flags hardcoded JWT fixtures).
  [
    "eyJ",
    "hbGciOiJIUzI1NiJ9",
    ".",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "signed-part-here",
  ].join(""),
] as const;

// Deterministic PRNG (mulberry32).
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

type GeneratedLeaf = string | number | boolean | null;

interface GeneratedCase {
  input: Record<string, unknown>;
  secretValues: string[];
}

function generateValue(
  rng: () => number,
  depth: number,
  secretValues: string[],
  underSecretKey = false,
): unknown {
  const roll = rng();
  if (depth <= 0 || roll < 0.35) {
    // Leaf.
    const leafRoll = rng();
    if (leafRoll < 0.45) return pick(rng, UNICODE_SAFE_VALUES);
    if (leafRoll < 0.6) return Math.floor(rng() * 1_000_000);
    if (leafRoll < 0.7) return rng() < 0.5;
    if (leafRoll < 0.8) return null;
    // A secret leaf. Only generated under a secret key — a long opaque
    // string under a safe key is legitimate payload and is not redacted.
    if (underSecretKey) {
      const value = pick(rng, SECRET_VALUES) + "-" + Math.floor(rng() * 1e6);
      secretValues.push(value);
      return value;
    }
    return pick(rng, UNICODE_SAFE_VALUES);
  }
  if (roll < 0.75) {
    // Nested object.
    const obj: Record<string, unknown> = {};
    const keys = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < keys; i++) {
      const useSecretKey = rng() < 0.4;
      const key = useSecretKey
        ? pick(rng, SECRET_KEYS)
        : `${pick(rng, SAFE_KEYS)}-${i}`;
      obj[key] = generateValue(rng, depth - 1, secretValues, useSecretKey);
    }
    return obj;
  }
  // Array (possibly mixed leaves, including secrets when under a secret key).
  const arr: unknown[] = [];
  const len = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < len; i++) {
    arr.push(generateValue(rng, depth - 1, secretValues, underSecretKey));
  }
  return arr;
}

function generateCase(seed: number): GeneratedCase {
  const rng = makeRng(seed);
  const secretValues: string[] = [];
  const input: Record<string, unknown> = {};
  const keys = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < keys; i++) {
    const useSecretKey = rng() < 0.4;
    const key = useSecretKey
      ? pick(rng, SECRET_KEYS)
      : `${pick(rng, SAFE_KEYS)}-${i}`;
    input[key] = generateValue(rng, 3, secretValues, useSecretKey);
  }
  return { input, secretValues };
}

function assertNoSecretLeak(output: unknown, secretValues: string[]): void {
  const serialized = JSON.stringify(output);
  for (const secret of secretValues) {
    expect(serialized).not.toContain(secret);
  }
}

const SECRET_KEY_SET = new Set<string>(SECRET_KEYS);

function assertStructurePreserved(
  input: unknown,
  output: unknown,
  path = "$",
  underSecretKey = false,
): void {
  if (Array.isArray(input)) {
    // Arrays nested under a secret key collapse to the redaction marker.
    if (underSecretKey) {
      expect(output, `${path} under secret key`).toBe(REDACTED_EVENT_VALUE);
      return;
    }
    expect(Array.isArray(output), `${path} should stay an array`).toBe(true);
    const outArr = output as unknown[];
    expect(outArr.length, `${path} array length`).toBe(input.length);
    input.forEach((item, i) =>
      assertStructurePreserved(item, outArr[i], `${path}[${i}]`, false),
    );
    return;
  }
  if (input !== null && typeof input === "object") {
    if (underSecretKey) {
      expect(output, `${path} under secret key`).toBe(REDACTED_EVENT_VALUE);
      return;
    }
    expect(
      output !== null && typeof output === "object" && !Array.isArray(output),
      `${path} should stay an object`,
    ).toBe(true);
    const inRec = input as Record<string, unknown>;
    const outRec = output as Record<string, unknown>;
    // Key set is preserved exactly — redaction must not drop or rename keys.
    expect(Object.keys(outRec).sort(), `${path} keys`).toEqual(
      Object.keys(inRec).sort(),
    );
    for (const key of Object.keys(inRec)) {
      assertStructurePreserved(
        inRec[key],
        outRec[key],
        `${path}.${key}`,
        SECRET_KEY_SET.has(key),
      );
    }
    return;
  }
  // Primitive leaf. Under a secret key any leaf (including booleans, numbers,
  // null and short strings) may be replaced with the redaction marker.
  if (underSecretKey) {
    if (output !== REDACTED_EVENT_VALUE) {
      expect(output, `${path} under secret key`).toBe(input);
    }
    return;
  }
  // Safe leaf: numbers, booleans, null and short strings pass through
  // untouched; longer strings may be redacted by value heuristics.
  if (
    typeof input === "number" ||
    typeof input === "boolean" ||
    input === null ||
    (typeof input === "string" && input.length < 8)
  ) {
    expect(output, `${path} primitive passthrough`).toBe(input);
  }
}

const CASE_COUNT = 40;

describe("redaction property tests (OPE-10270)", () => {
  describe("sanitizeRecord", () => {
    for (let seed = 1; seed <= CASE_COUNT; seed++) {
      it(`case seed=${seed}: no leak, structure preserved, idempotent`, () => {
        const { input, secretValues } = generateCase(seed);
        const out = sanitizeRecord(input);

        assertNoSecretLeak(out, secretValues);
        assertStructurePreserved(input, out);

        // Idempotence: second pass is a no-op.
        const second = sanitizeRecord(out);
        expect(second).toEqual(out);
      });
    }
  });

  describe("redactEventPayload", () => {
    for (let seed = 101; seed <= 100 + CASE_COUNT; seed++) {
      it(`case seed=${seed}: no leak, structure preserved, idempotent`, () => {
        const { input, secretValues } = generateCase(seed);
        const out = redactEventPayload(input);

        expect(out).not.toBeNull();
        assertNoSecretLeak(out, secretValues);
        assertStructurePreserved(input, out);

        const second = redactEventPayload(out);
        expect(second).toEqual(out);
      });
    }
  });

  describe("targeted regression cases", () => {
    it("masks secrets nested in arrays of objects without leaking", () => {
      const input = {
        items: [
          { apiKey: "sk-live-zzzzzzzzzzzzzzzzzzzzzzzzzzzz", note: "safe" },
          { nested: [{ password: "p@ssw0rd-aaaaaaaaaaaaaaaaaaaaaaaa" }] },
        ],
        safe: "visible",
      };
      const out = sanitizeRecord(input);
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("sk-live-zzzzzzzzzzzzzzzzzzzzzzzzzzzz");
      expect(serialized).not.toContain("p@ssw0rd-aaaaaaaaaaaaaaaaaaaaaaaa");
      expect(out.items).toHaveLength(2);
      expect((out.items as unknown[])[0]).toMatchObject({ note: "safe" });
      expect(sanitizeRecord(out)).toEqual(out);
    });

    it("preserves unicode content in non-secret fields", () => {
      const input = {
        message: "пароль в соседнем поле →",
        password: "unicode-nearby-🚀🚀🚀🚀🚀🚀",
        备注: "中文备注内容",
      };
      const out = sanitizeRecord(input);
      expect(out.message).toBe("пароль в соседнем поле →");
      expect(out.备注).toBe("中文备注内容");
      expect(JSON.stringify(out)).not.toContain("unicode-nearby-");
      expect((out as Record<string, unknown>).password).toBe(REDACTED_EVENT_VALUE);
    });

    it("treats already-redacted values idempotently", () => {
      const input = {
        apiKey: REDACTED_EVENT_VALUE,
        nested: { password: REDACTED_EVENT_VALUE, safe: "ok" },
        list: [REDACTED_EVENT_VALUE, "plain"],
      };
      const out = sanitizeRecord(input);
      expect(out).toEqual(input);
      expect(sanitizeRecord(out)).toEqual(out);
    });

    it("does not leak secrets through already-masked URL userinfo", () => {
      const text = "connect to postgres://user:supersecretpassword123@db.internal:5432/app";
      const redacted = redactSensitiveText(text);
      expect(redacted).not.toContain("supersecretpassword123");
      expect(redacted).toContain(URL_CREDENTIAL_MASK);
      expect(redactSensitiveText(redacted)).toBe(redacted);
    });

    it("keeps redactEventPayload idempotent on already-redacted envelopes", () => {
      const payload = {
        eventType: "workspace.file.referenced",
        payload: {
          apiKey: REDACTED_EVENT_VALUE,
          args: ["--token", REDACTED_EVENT_VALUE, "--verbose"],
        },
      };
      const once = redactEventPayload(payload);
      expect(redactEventPayload(once)).toEqual(once);
    });
  });
});
