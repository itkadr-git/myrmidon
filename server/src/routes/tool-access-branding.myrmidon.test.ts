import { describe, expect, it } from "vitest";
import {
  cloudConnectorEnrollmentOutcomeHtml,
  connectionIntentOAuthOutcomeHtml,
} from "./tool-access.js";

// B1b: the OAuth return page and the Cloud enrollment completion page both
// name the product.
describe("connection authorization return page (B1b)", () => {
  it("names the product while the window closes itself", () => {
    const html = connectionIntentOAuthOutcomeHtml({
      interactionId: "interaction-1",
      issueId: null,
      outcome: "connected",
    });
    expect(html).toContain("<p>Returning to Myrmidon…</p>");
    expect(html).not.toContain("Returning to Paperclip");
  });

  it("names the product on the Cloud enrollment page too (B1c)", () => {
    const html = cloudConnectorEnrollmentOutcomeHtml("PRE", "/apps/connect");
    expect(html).toContain("Myrmidon connected");
  });
});
