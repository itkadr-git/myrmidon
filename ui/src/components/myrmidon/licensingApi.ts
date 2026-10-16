// myrmidon(LICENSING): licensing surface API (instance admin only):
//   GET  /api/licensing/status         install id, license request blob, issuer flag
//   POST /api/licensing/parse-request  read a pasted MYRQ1 request
//   POST /api/licensing/issue          sign a module license
//   GET  /api/licensing/issued         journal of issued licenses
import { api } from "@/api/client";

export const LICENSE_MODULES = ["google-ai", "antigravity", "chatgpt-pool"] as const;
export type LicenseModule = (typeof LICENSE_MODULES)[number];

export interface LicensingStatus {
  installId: string;
  source: "env" | "machine-id" | "generated";
  board: string;
  knownModules: string[];
  issuerConfigured: boolean;
  request: string;
}

export interface ParsedLicenseRequest {
  instanceId: string;
  board: string;
  modules: string[];
  requestedAt: string;
}

export interface IssueLicenseInput {
  request?: string;
  instanceId?: string;
  modules: string[];
  days: number | null;
  watermark: string | null;
}

export interface IssuedLicense {
  license: string;
  id: string;
  payload: { instance_id: string; modules: string[]; features: string[]; expires: number | null; watermark: string | null };
}

export interface IssuedLicenseRecord {
  id: string;
  issuedAt: string;
  issuedBy: string | null;
  instanceId: string;
  modules: string[];
  features: string[];
  expires: number | null;
  watermark: string | null;
}

export const licensingStatusQueryKey = ["myrmidon", "licensing", "status"] as const;
export const licensingIssuedQueryKey = ["myrmidon", "licensing", "issued"] as const;

export const licensingApi = {
  status: (modules?: readonly string[]) =>
    api.get<LicensingStatus>(
      modules && modules.length > 0 ? `/licensing/status?modules=${modules.join(",")}` : "/licensing/status",
    ),
  parseRequest: (request: string) => api.post<ParsedLicenseRequest>("/licensing/parse-request", { request }),
  issue: (input: IssueLicenseInput) => api.post<IssuedLicense>("/licensing/issue", input),
  issued: () => api.get<IssuedLicenseRecord[]>("/licensing/issued"),
};
