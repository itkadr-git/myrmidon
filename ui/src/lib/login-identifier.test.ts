import { describe, expect, it } from "vitest";
import { resolveSignInEmail } from "./login-identifier";

describe("resolveSignInEmail", () => {
  it("keeps an email as typed (trimmed)", () => {
    expect(resolveSignInEmail("  Alice@Example.com ")).toBe("Alice@Example.com");
  });
  it("turns a login into the managed address, lower-cased", () => {
    expect(resolveSignInEmail("Alice.Ops")).toBe("alice.ops@myr.local");
  });
  it("leaves an empty value empty", () => {
    expect(resolveSignInEmail("   ")).toBe("");
  });
});
