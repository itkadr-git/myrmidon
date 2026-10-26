import { describe, expect, it } from "vitest";
import { isProviderErrorAsContent, PROVIDER_ERROR_AS_CONTENT_PATTERNS } from "./execute.js";

describe("provider error responses disguised as content", () => {
  it("recognizes the HTTP-200 overload response", () => {
    expect(isProviderErrorAsContent("The server is (sometimes) overloaded due to high user traffic. Please retry!")).toBe(true);
  });

  it("keeps short normal model responses as content", () => {
    for (const response of ["Hello.", "Try again tomorrow.", "The server is helpful.", "Quota means a limit.", "Please retry this command later."]) {
      expect(isProviderErrorAsContent(response)).toBe(false);
    }
  });

  it("keeps the detector patterns in a testable constant", () => {
    expect(PROVIDER_ERROR_AS_CONTENT_PATTERNS.length).toBeGreaterThanOrEqual(1);
  });
});
