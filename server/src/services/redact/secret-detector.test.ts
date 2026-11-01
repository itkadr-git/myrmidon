import { describe, expect, it } from "vitest";
import {
  calculateShannonEntropy,
  detectSecrets,
  isBase64Data,
  isSecret,
  isUuid,
  redactSecrets,
  SecretDetector,
} from "./secret-detector.js";
import { KNOWN_PREFIX_PATTERNS } from "./patterns.js";

describe("Secret Detector & Redactor (OPE-10194)", () => {
  describe("Known Prefix Detection", () => {
    it("detects and redacts Paperclip tokens (pcp_)", () => {
      const pcpLiveToken = ["pcp", "live", "paperclip_test_token_value"].join("_");
      const pcpInviteToken = ["pcp", "invite", "test_invite_value"].join("_");
      const input = `Connecting with agent token ${pcpLiveToken} and invite ${pcpInviteToken}.`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        "Connecting with agent token <redacted-secret:pcp> and invite <redacted-secret:pcp>.",
      );
    });

    it("detects and redacts GitHub personal access tokens (ghp_)", () => {
      const ghpToken = ["ghp", "testfixtureplaceholdervalueforgithub"].join("_");
      const input = `Clone failed using token: ${ghpToken} in git remote url`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        "Clone failed using token: <redacted-secret:ghp> in git remote url",
      );
    });

    it("detects and redacts OpenAI and LiteLLM keys (sk- and sk-proj-)", () => {
      const skToken = ["sk", "testfixtureplaceholdervalueforopenai"].join("-");
      const skProjToken = ["sk", "proj", "testfixtureplaceholdervalueforproject"].join("-");
      const input = `OpenAI key ${skToken} or project key ${skProjToken}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        "OpenAI key <redacted-secret:sk> or project key <redacted-secret:sk>",
      );
    });

    it("detects and redacts Bearer authorization tokens by default", () => {
      const bearerToken = "not-a-real-token-placeholder-value";
      const input = `Authorization: Bearer ${bearerToken} for request`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        "Authorization: <redacted-secret:bearer> for request",
      );
    });

    it("supports preserving Bearer auth scheme when preserveBearerScheme is true", () => {
      const bearerToken = "not-a-real-token-placeholder-value";
      const input = `Authorization: Bearer ${bearerToken} for request`;
      const redacted = redactSecrets(input, { preserveBearerScheme: true });

      expect(redacted).toBe(
        "Authorization: Bearer <redacted-secret:bearer> for request",
      );
    });

    it("prioritizes specific prefix when Bearer is followed by a known token", () => {
      const pcpToken = ["pcp", "live", "placeholder_value_for_test_only"].join("_");
      const input =
        `api_call --header 'Authorization: Bearer ${pcpToken}' https://api.example.com`;
      const redacted = redactSecrets(input, { preserveBearerScheme: true });

      expect(redacted).toBe(
        "api_call --header 'Authorization: Bearer <redacted-secret:pcp>' https://api.example.com",
      );
    });

    it("handles multiple mixed tokens in a single log message", () => {
      const pcpSecToken = ["pcp", "sec", "abcdef1234567890"].join("_");
      const ghpMultiToken = ["ghp", "ABCDEFGHIJKLMNOP1234567890"].join("_");
      const skMultiToken = ["sk", "1234567890abcdef1234567890"].join("-");
      const input = `Auth debug: pcp_agent=${pcpSecToken} ghp=${ghpMultiToken} sk=${skMultiToken}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        "Auth debug: pcp_agent=<redacted-secret:pcp> ghp=<redacted-secret:ghp> sk=<redacted-secret:sk>",
      );
    });
  });

  describe("Shannon Entropy Filter for Cryptographic Keys", () => {
    it("detects 32-character random hex cryptographic keys (> 20 chars)", () => {
      // 32-byte hex string (high entropy > 3.4)
      const secretHex = ["4f8a9b2c", "3d1e0f7a", "8b9c0d1e", "2f3a4b5c"].join("");
      const input = `DATABASE_SECRET_KEY="${secretHex}" loaded into runtime`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        'DATABASE_SECRET_KEY="<redacted-secret:entropy>" loaded into runtime',
      );
    });

    it("detects 64-character random hex cryptographic keys (256-bit)", () => {
      const secretHex64 = [
        "e3b0c44298fc1c14",
        "9afbf4c8996fb924",
        "27ae41e4649b934c",
        "a495991b7852b855",
      ].join("");
      const input = `Signing key: ${secretHex64}. Keep secret.`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(
        "Signing key: <redacted-secret:entropy>. Keep secret.",
      );
    });

    it("detects random 32-byte Base64 cryptographic keys", () => {
      // 32 random bytes encoded in base64 (entropy > 4.5, non-text)
      const randomB64Key = [
        "mj8cgtR+",
        "YbUC+DyR",
        "p00uW4DD",
        "9hlCdei/",
        "MWSXyv0g",
        "U4Y=",
      ].join("");
      const input = `HMAC_KEY='${randomB64Key}'`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe("HMAC_KEY='<redacted-secret:entropy>'");
    });

    it("detects random alphanumeric API secret tokens", () => {
      const randomAlphaNum = [
        "xK9mP2vL",
        "8nQ4wR1t",
        "Y7uI0oP3",
        "aS5dF6gH",
      ].join("");
      const input = `token: ${randomAlphaNum}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe("token: <redacted-secret:entropy>");
    });

    it("ignores strings with length <= 20 characters", () => {
      // 16 chars (short hex)
      const shortString = "4f8a9b2c3d1e0f7a";
      const input = `Short key: ${shortString}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
    });

    it("ignores long strings (> 20 chars) with low entropy (repeated characters)", () => {
      const repeated = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const input = `Padding string: ${repeated}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
    });

    it("ignores natural language variable names and long identifiers (> 20 chars)", () => {
      const identifier1 = "this_is_a_very_long_variable_name_without_spaces";
      const identifier2 = "getPaperclipProjectResourceConfiguration";
      const input = `Checking const ${identifier1} and fn ${identifier2}()`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
    });

    it("ignores repeated numeric sequences (> 20 chars)", () => {
      const repeatedDigits = "123456789012345678901234567890";
      const input = `Metric count: ${repeatedDigits}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
    });
  });

  describe("Minimizing False Positives on UUIDs and Base64 Data", () => {
    it("preserves standard UUID v4 identifiers without redaction", () => {
      const uuid = "346225af-3d60-4a31-824c-dbd57230355b";
      const input = `Issue ID: ${uuid} assigned to agent`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isUuid(uuid)).toBe(true);
    });

    it("preserves standard UUID v1 identifiers without redaction", () => {
      const uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
      const input = `Entity UUID: ${uuid}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
    });

    it("preserves URN formatted UUIDs without redaction", () => {
      const urnUuid = "urn:uuid:346225af-3d60-4a31-824c-dbd57230355b";
      const input = `Resource: ${urnUuid}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isUuid(urnUuid)).toBe(true);
    });

    it("preserves Base64 Data URIs (e.g. embedded images) without redaction", () => {
      const dataUri =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const input = `<img src="${dataUri}" alt="icon" />`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isBase64Data(dataUri)).toBe(true);
    });

    it("preserves Base64-encoded PNG file data without redaction", () => {
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const input = `Avatar data: ${pngBase64}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isBase64Data(pngBase64)).toBe(true);
    });

    it("preserves Base64-encoded PDF document headers without redaction", () => {
      const pdfBase64 =
        Buffer.from("%PDF-1.5 Some document text content here").toString("base64");
      const input = `Document: ${pdfBase64}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isBase64Data(pdfBase64)).toBe(true);
    });

    it("preserves Base64-encoded JSON payloads without redaction", () => {
      const jsonPayload = Buffer.from(
        JSON.stringify({ user: "alex", role: "admin", company: "Myrmidon" }),
      ).toString("base64");
      const input = `Payload token payload=${jsonPayload}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isBase64Data(jsonPayload)).toBe(true);
    });

    it("preserves Base64-encoded plain English text messages without redaction", () => {
      const textBase64 = Buffer.from(
        "This is an ordinary human readable sentence encoded in base64 format.",
      ).toString("base64");
      const input = `Message: ${textBase64}`;
      const redacted = redactSecrets(input);

      expect(redacted).toBe(input);
      expect(isBase64Data(textBase64)).toBe(true);
    });
  });

  describe("API Functions & Utilities", () => {
    it("calculateShannonEntropy computes expected values", () => {
      expect(calculateShannonEntropy("")).toBe(0);
      expect(calculateShannonEntropy("a")).toBe(0);
      expect(calculateShannonEntropy("aaaa")).toBe(0);

      // Max entropy for 2 distinct characters is 1.0
      expect(calculateShannonEntropy("ab")).toBeCloseTo(1.0, 5);

      // Random hex key should have high entropy (~3.8)
      const hexEntropy = calculateShannonEntropy("4f8a9b2c3d1e0f7a8b9c0d1e2f3a4b5c");
      expect(hexEntropy).toBeGreaterThan(3.5);
    });

    it("detectSecrets returns detailed match objects", () => {
      const inviteToken = ["pcp", "invite", "test_invite_value"].join("_");
      const text = `Found ${inviteToken} in config`;
      const matches = detectSecrets(text);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        type: "pcp",
        value: inviteToken,
        raw: inviteToken,
        start: 6,
        end: 6 + inviteToken.length,
        placeholder: "<redacted-secret:pcp>",
      });
    });

    it("isSecret correctly identifies individual secret strings", () => {
      const pcpSample = ["pcp", "live", "paperclipPlaceholderSample"].join("_");
      const ghpSample = ["ghp", "githubPlaceholderSampleValueOnly"].join("_");
      const skSample = ["sk", "openai_placeholder_sample_value_only"].join("-");
      const hexSample = ["4f8a9b2c", "3d1e0f7a", "8b9c0d1e", "2f3a4b5c"].join("");

      expect(isSecret(pcpSample)).toBe(true);
      expect(isSecret(ghpSample)).toBe(true);
      expect(isSecret(skSample)).toBe(true);
      expect(isSecret(hexSample)).toBe(true);

      // Non-secrets
      expect(isSecret("346225af-3d60-4a31-824c-dbd57230355b")).toBe(false);
      expect(isSecret("short_word")).toBe(false);
      expect(isSecret("this_is_a_very_long_variable_name_without_spaces")).toBe(false);
    });

    it("SecretDetector class supports custom options and placeholders", () => {
      const detector = new SecretDetector({
        placeholder: (type) => `[MASKED_${type.toUpperCase()}]`,
      });

      const skClassToken = ["sk", "1234567890abcdef1234567890"].join("-");
      const input = `Secret ${skClassToken} found`;
      const redacted = detector.redact(input);

      expect(redacted).toBe("Secret [MASKED_SK] found");
      expect(detector.isSecret(skClassToken)).toBe(true);
      expect(detector.calculateEntropy("4f8a9b2c3d1e0f7a8b9c0d1e2f3a4b5c")).toBeGreaterThan(3.5);
    });

    it("exports standard KNOWN_PREFIX_PATTERNS", () => {
      expect(KNOWN_PREFIX_PATTERNS.map((p) => p.name)).toEqual([
        "pcp",
        "ghp",
        "sk",
        "bearer",
      ]);
    });
  });
});
