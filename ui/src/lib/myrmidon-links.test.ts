import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCS_URL,
  FEEDBACK_URL,
  FEEDBACK_TERMS_URL,
  resolveFeedbackTermsUrl,
  setFeedbackTermsUrlForTesting,
} from "./myrmidon-links";

afterEach(() => {
  setFeedbackTermsUrlForTesting(null);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Myrmidon product links", () => {
  it("links to the fork documentation and issue tracker", () => {
    expect(DOCS_URL).toBe("https://github.com/itkadr-git/myrmidon/tree/main/docs");
    expect(FEEDBACK_URL).toBe("https://github.com/itkadr-git/myrmidon/issues");
  });

  it.each([undefined, "", "   "])("omits terms without an operator URL (%s)", (value) => {
    expect(resolveFeedbackTermsUrl(value)).toBeNull();
  });

  it("preserves and trims the operator's terms URL", () => {
    expect(resolveFeedbackTermsUrl("  https://example.org/terms  ")).toBe("https://example.org/terms");
  });

  it("reads the Vite override when the module is loaded", async () => {
    vi.stubEnv("VITE_FEEDBACK_TERMS_URL", " https://example.org/operator-terms ");
    vi.resetModules();
    const { FEEDBACK_TERMS_URL } = await import("./myrmidon-links");
    expect(FEEDBACK_TERMS_URL).toBe("https://operator.example.org/operator-terms");
  });

  it("does not invent default sharing terms", async () => {
    vi.stubEnv("VITE_FEEDBACK_TERMS_URL", "");
    vi.resetModules();
    const { FEEDBACK_TERMS_URL } = await import("./myrmidon-links");
    expect(FEEDBACK_TERMS_URL).toBeNull();
  });

  it("supports explicit runtime overrides in tests", () => {
    setFeedbackTermsUrlForTesting("https://operator.example.org/test-terms");
    expect(FEEDBACK_TERMS_URL).toBe("https://operator.example.org/test-terms");
    setFeedbackTermsUrlForTesting(null);
    expect(FEEDBACK_TERMS_URL).toBeNull();
  });
});
