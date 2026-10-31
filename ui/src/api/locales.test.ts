import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { localesApi } from "./locales";

describe("localesApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  describe("getInstalledLocales", () => {
    it("calls endpoint without query params when none provided", async () => {
      mockApi.get.mockResolvedValue({
        baseLocale: "en",
        totalBaseKeys: 437,
        locales: [],
        total: 0,
      });

      await localesApi.getInstalledLocales();
      expect(mockApi.get).toHaveBeenCalledWith("/myrmidon/locales");
    });

    it("formats query params correctly", async () => {
      mockApi.get.mockResolvedValue({
        baseLocale: "en",
        totalBaseKeys: 437,
        locales: [],
        total: 0,
      });

      await localesApi.getInstalledLocales({
        type: "builtin",
        minCoverage: 80,
        search: "rus",
      });

      expect(mockApi.get).toHaveBeenCalledWith(
        "/myrmidon/locales?type=builtin&minCoverage=80&search=rus",
      );
    });

    it("omits type param when type is 'all'", async () => {
      mockApi.get.mockResolvedValue({
        baseLocale: "en",
        totalBaseKeys: 437,
        locales: [],
        total: 0,
      });

      await localesApi.getInstalledLocales({
        type: "all",
        minCoverage: 50,
      });

      expect(mockApi.get).toHaveBeenCalledWith("/myrmidon/locales?minCoverage=50");
    });
  });

  describe("getLocaleCoverage", () => {
    it("calls detail endpoint with encoded locale", async () => {
      mockApi.get.mockResolvedValue({
        locale: "pt-BR",
        name: "Portuguese (Brazil)",
        baseLocale: "en",
        isBuiltin: true,
        isDefault: false,
        version: 1,
        totalKeys: 437,
        matchedKeysCount: 437,
        missingKeysCount: 0,
        extraKeysCount: 0,
        coveragePercent: 100,
        missingKeys: [],
        extraKeys: [],
        updatedAt: null,
      });

      const res = await localesApi.getLocaleCoverage("pt-BR");
      expect(mockApi.get).toHaveBeenCalledWith("/myrmidon/locales/pt-BR/coverage");
      expect(res.locale).toBe("pt-BR");
      expect(res.coveragePercent).toBe(100);
    });
  });
});
