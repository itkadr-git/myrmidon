// myrmidon(1.6.7 SETTINGS-GENERAL-CRASH): the 403 "Instance admin access
// required" of a non-admin is shown as the translated message in the settings
// panels (it used to appear as raw English, or not at all); other errors keep
// the server's text, and an error without text falls back to the panel's key.

import { describe, expect, it } from "vitest";
import {
  describeSettingsError,
  INSTANCE_ADMIN_REQUIRED_KEY,
  isInstanceAdminRequiredError,
} from "./settingsErrors";

// The shape of ApiError in ui/src/api/client.ts: an Error with `status` and `body`.
class FakeApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.body = { error: message };
  }
}

const catalog: Record<string, string> = {
  [INSTANCE_ADMIN_REQUIRED_KEY]: "Нужны права администратора экземпляра",
  "panel.loadFailed": "Не удалось загрузить",
};
const t = (key: string) => catalog[key] ?? key;

describe("settings error text", () => {
  it("names the catalog key the ru/en strings live under", () => {
    expect(INSTANCE_ADMIN_REQUIRED_KEY).toBe("settings.instanceAdminRequired");
  });

  it("recognises the instance-admin 403 and nothing else", () => {
    expect(isInstanceAdminRequiredError(new FakeApiError("Instance admin access required", 403))).toBe(true);
    expect(isInstanceAdminRequiredError(new FakeApiError("Instance admin access required", 500))).toBe(false);
    expect(isInstanceAdminRequiredError(new FakeApiError("Forbidden", 403))).toBe(false);
    expect(isInstanceAdminRequiredError(new Error("Instance admin access required"))).toBe(false);
    expect(isInstanceAdminRequiredError(null)).toBe(false);
    expect(isInstanceAdminRequiredError("Instance admin access required")).toBe(false);
  });

  it("shows the translated message for the instance-admin 403", () => {
    const err = new FakeApiError("Instance admin access required", 403);
    expect(describeSettingsError(err, t, "panel.loadFailed")).toBe("Нужны права администратора экземпляра");
  });

  it("keeps the server message of any other error", () => {
    expect(describeSettingsError(new FakeApiError("Unknown setting key: 'x'", 404), t, "panel.loadFailed")).toBe(
      "Unknown setting key: 'x'",
    );
    expect(describeSettingsError(new FakeApiError("Forbidden", 403), t, "panel.loadFailed")).toBe("Forbidden");
  });

  it("falls back to the panel's key when there is no message", () => {
    expect(describeSettingsError(new Error(""), t, "panel.loadFailed")).toBe("Не удалось загрузить");
    expect(describeSettingsError(undefined, t, "panel.loadFailed")).toBe("Не удалось загрузить");
    expect(describeSettingsError({ status: 500 }, t, "panel.loadFailed")).toBe("Не удалось загрузить");
  });
});
