// myrmidon(GOOGLE-AI-CONNECT-UI): parse the owner's pasted cookie bundle.
//
// The owner exports their gemini.google.com cookies from their own browser
// (Firefox recommended by the session runbook) and pastes the JSON here. This
// module keeps ONLY the two names the bridge session needs and answers a
// value-free summary for the UI. The parsed bundle is a string handed straight
// to the secret store; nothing here logs or returns a cookie value, and the
// caller must never put one in a journal row or an error message.

import { GAI_REQUIRED_COOKIE_NAMES } from "@paperclipai/shared/myrmidon-google-ai-connector";

export interface ParsedCookieBundle {
  /** JSON array of {name, value} for the required cookies, in fixed order. */
  bundleJson: string;
  /** Which required names the paste carried (sorted, value-free). */
  presentNames: string[];
  /** How many cookies the paste had in total (for the "ignored the rest" notice). */
  totalCookies: number;
}

export class CookiePasteError extends Error {
  constructor(readonly code: "not_json" | "not_an_object" | "missing_cookies", hint: string) {
    super(hint);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the two export shapes:
 *  - an array of cookie objects (`[{name, value, ...}, ...]`);
 *  - a map of name to value (`{"__Secure-1PSID": "...", ...}`).
 * Anything else (a Netscape cookies.txt, a header line, plain "name=value"
 * pairs) is refused with the reason the screen shows.
 */
export function parseCookiePaste(raw: string): ParsedCookieBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new CookiePasteError(
      "not_json",
      "the paste is not JSON — export the cookies from the browser and paste the file contents",
    );
  }

  const pairs: Array<{ name: string; value: string }> = [];
  if (Array.isArray(parsed)) {
    // EditThisCookie / FireCookie style export: objects with name+value.
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const value = typeof entry.value === "string" ? entry.value.trim() : "";
      if (name && value) pairs.push({ name, value });
    }
  } else if (isRecord(parsed)) {
    // A name->value map, or a wrapper object that carries such an array.
    const entries = Object.entries(parsed);
    for (const [name, value] of entries) {
      if (typeof value === "string" && value.trim()) pairs.push({ name: name.trim(), value: value.trim() });
    }
  } else {
    throw new CookiePasteError("not_an_object", "expected a cookie array or a name-value object");
  }

  const wanted = new Set<string>(GAI_REQUIRED_COOKIE_NAMES);
  const picked = new Map<string, string>();
  for (const { name, value } of pairs) {
    if (wanted.has(name) && !picked.has(name)) picked.set(name, value);
  }
  const missing = GAI_REQUIRED_COOKIE_NAMES.filter((name) => !picked.has(name));
  if (missing.length > 0) {
    throw new CookiePasteError(
      "missing_cookies",
      `the paste is missing ${missing.join(", ")} — sign in to gemini.google.com in that browser first, then export all cookies of the site`,
    );
  }
  const bundle = GAI_REQUIRED_COOKIE_NAMES.map((name) => ({ name, value: picked.get(name)! }));
  return {
    bundleJson: JSON.stringify(bundle),
    presentNames: GAI_REQUIRED_COOKIE_NAMES.filter((name) => picked.has(name)),
    totalCookies: pairs.length,
  };
}

/** Value-free shape check for a bridge-facing bundle (used by the delivery
 * endpoint before it answers). */
export function isSessionBundleJson(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== GAI_REQUIRED_COOKIE_NAMES.length) return false;
  return GAI_REQUIRED_COOKIE_NAMES.every((name, index) => {
    const entry = value[index] as unknown;
    return isRecord(entry) && entry.name === name && typeof entry.value === "string" && entry.value.length > 0;
  });
}
