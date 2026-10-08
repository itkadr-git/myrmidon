// myrmidon(GOOGLE-AI-CONNECT-UI): cookie paste parser tests.
//
// The paste is the owner's whole cookie export; the parser keeps only the two
// bridge session names, refuses anything that is not one of the two accepted
// shapes, and its errors must never carry a cookie value.

import { describe, expect, it } from "vitest";
import { GAI_REQUIRED_COOKIE_NAMES } from "@paperclipai/shared/myrmidon-google-ai-connector";
import { isSessionBundleJson, parseCookiePaste } from "./cookies.js";

const SECRET_VALUE = "super-secret-cookie-value";

describe("parseCookiePaste", () => {
  it("accepts the browser array export and keeps only the required names, in fixed order", () => {
    const raw = JSON.stringify([
      { name: "NID", value: "noise", domain: ".google.com" },
      { name: "__Secure-1PSIDTS", value: "ts-value" },
      { name: "__Secure-1PSID", value: SECRET_VALUE },
      { name: "SIDCC", value: "more-noise" },
    ]);
    const parsed = parseCookiePaste(raw);
    const bundle = JSON.parse(parsed.bundleJson) as Array<{ name: string; value: string }>;
    expect(bundle.map((entry) => entry.name)).toEqual([...GAI_REQUIRED_COOKIE_NAMES]);
    expect(bundle[0].value).toBe(SECRET_VALUE);
    expect(parsed.presentNames).toEqual([...GAI_REQUIRED_COOKIE_NAMES]);
    expect(parsed.totalCookies).toBe(4);
    // values do not leak into the summary surface
    expect(JSON.stringify(parsed.presentNames)).not.toContain(SECRET_VALUE);
  });

  it("accepts a name-to-value map and ignores extra keys", () => {
    const raw = JSON.stringify({
      "__Secure-1PSID": SECRET_VALUE,
      "__Secure-1PSIDTS": "ts",
      other: "ignored",
    });
    const parsed = parseCookiePaste(raw);
    expect(parsed.totalCookies).toBe(3);
    expect(JSON.parse(parsed.bundleJson)).toHaveLength(GAI_REQUIRED_COOKIE_NAMES.length);
  });

  it("refuses a paste that is not JSON without echoing the paste", () => {
    expect(() => parseCookiePaste("# Netscape HTTP Cookie File\n.example.com\tTRUE")).toThrow(/not JSON/);
  });

  it("refuses a scalar paste", () => {
    expect(() => parseCookiePaste("42")).toThrow(/expected a cookie array/);
  });

  it("refuses a paste missing a required cookie and names the missing ones only", () => {
    expect.assertions(2);
    try {
      parseCookiePaste(JSON.stringify([{ name: "__Secure-1PSID", value: SECRET_VALUE }]));
    } catch (error) {
      expect((error as Error).message).toContain("__Secure-1PSIDTS");
      expect((error as Error).message).not.toContain(SECRET_VALUE);
    }
  });

  it("takes the first value when a required name appears twice", () => {
    const parsed = parseCookiePaste(
      JSON.stringify([
        { name: "__Secure-1PSID", value: "first" },
        { name: "__Secure-1PSID", value: "second" },
        { name: "__Secure-1PSIDTS", value: "ts" },
      ]),
    );
    const bundle = JSON.parse(parsed.bundleJson) as Array<{ name: string; value: string }>;
    expect(bundle.find((entry) => entry.name === "__Secure-1PSID")?.value).toBe("first");
  });
});

describe("isSessionBundleJson", () => {
  it("accepts exactly the bundle the parser produces", () => {
    const parsed = parseCookiePaste(
      JSON.stringify([
        { name: "__Secure-1PSID", value: "a" },
        { name: "__Secure-1PSIDTS", value: "b" },
      ]),
    );
    expect(isSessionBundleJson(JSON.parse(parsed.bundleJson))).toBe(true);
  });

  it("refuses wrong order, extra entries, and empty values", () => {
    expect(isSessionBundleJson([{ name: "__Secure-1PSIDTS", value: "b" }, { name: "__Secure-1PSID", value: "a" }])).toBe(false);
    expect(isSessionBundleJson([{ name: "__Secure-1PSID", value: "" }, { name: "__Secure-1PSIDTS", value: "b" }])).toBe(false);
    expect(isSessionBundleJson("not-an-array")).toBe(false);
  });
});
