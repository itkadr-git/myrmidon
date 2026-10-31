import type {
  InstalledLocalesQuery,
  InstalledLocalesResponse,
  LocaleCoverageDetail,
} from "@myrmidon/shared";
import { api } from "./client";

export const localesApi = {
  getInstalledLocales: (query?: InstalledLocalesQuery) => {
    const params = new URLSearchParams();
    if (query?.type && query.type !== "all") {
      params.set("type", query.type);
    }
    if (query?.minCoverage !== undefined) {
      params.set("minCoverage", String(query.minCoverage));
    }
    if (query?.search) {
      params.set("search", query.search);
    }
    const qs = params.toString();
    return api.get<InstalledLocalesResponse>(`/myrmidon/locales${qs ? `?${qs}` : ""}`);
  },

  getLocaleCoverage: (locale: string) =>
    api.get<LocaleCoverageDetail>(`/myrmidon/locales/${encodeURIComponent(locale)}/coverage`),
};
