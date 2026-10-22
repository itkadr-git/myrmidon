// @vitest-environment jsdom
// myrmidon(1.6.5-OWNER-DM-FILTER): the settings page added by this change has
// to resolve to its own tab, otherwise the tab bar highlights "General" while
// the owner delivery screen is on screen.
import { describe, expect, it } from "vitest";
import { getCompanySettingsTab } from "./CompanySettingsNav";

describe("myrmidon(1.6.5-OWNER-DM-FILTER) settings nav", () => {
  it("resolves the owner delivery page to its own tab", () => {
    expect(getCompanySettingsTab("/company/settings/owner-delivery")).toBe("owner-delivery");
    expect(getCompanySettingsTab("/PAP/company/settings/owner-delivery")).toBe("owner-delivery");
  });

  it("keeps the plain settings paths on their own tabs", () => {
    expect(getCompanySettingsTab("/company/settings")).toBe("general");
    expect(getCompanySettingsTab("/company/settings/wip-limit")).toBe("wip-limit");
  });
});