// myrmidon(GOOGLE-AI-CONNECT-UI): API client for the Settings → Google AI Pro section.
// Server side: server/src/myrmidon/google-ai-connector/routes.ts.

import { api } from "@/api/client";
import type {
  GaiCapability,
  GaiConnection,
  GaiGenerateResult,
  GaiGrant,
  GaiGrantTargetKind,
  GaiJournalEntry,
  GaiStateView,
} from "@paperclipai/shared/myrmidon-google-ai-connector";

export const gaiStateQueryKey = ["myrmidon", "google-ai", "state"] as const;

function company(companyId: string): string {
  return `companyId=${encodeURIComponent(companyId)}`;
}

export interface GaiSetGrantInput {
  capability: GaiCapability;
  targetKind: GaiGrantTargetKind;
  agentId?: string;
  caste?: string;
}

export interface GaiHealthCheckResult {
  health: GaiStateView["health"];
  status: GaiConnection["status"] | null;
  staleNow: boolean;
}

export const gaiApi = {
  state: (companyId: string) => api.get<GaiStateView>(`/myrmidon/google-ai-connector/state?${company(companyId)}`),
  connect: (companyId: string, cookieJson: string) =>
    api.post<{ connection: GaiConnection; keptCookies: string[]; ignoredCookies: number }>(
      "/myrmidon/google-ai-connector/connect",
      { companyId, cookieJson },
    ),
  reconnect: (companyId: string, cookieJson: string) =>
    api.post<{ connection: GaiConnection; keptCookies: string[]; ignoredCookies: number }>(
      "/myrmidon/google-ai-connector/reconnect",
      { companyId, cookieJson },
    ),
  disconnect: (companyId: string) =>
    api.delete<{ removed: boolean }>(`/myrmidon/google-ai-connector/connection?${company(companyId)}`),
  setGrant: (companyId: string, input: GaiSetGrantInput) =>
    api.put<{ grant: GaiGrant }>(`/myrmidon/google-ai-connector/grants?${company(companyId)}`, { companyId, ...input }),
  removeGrant: (grantId: string, companyId: string) =>
    api.delete<{ removed: boolean }>(`/myrmidon/google-ai-connector/grants/${encodeURIComponent(grantId)}?${company(companyId)}`),
  check: (companyId: string) => api.post<GaiHealthCheckResult>(`/myrmidon/google-ai-connector/check?${company(companyId)}`, {}),
  trial: (companyId: string, prompt?: string) =>
    api.post<GaiGenerateResult>("/myrmidon/google-ai-connector/trial", { companyId, prompt }),
  journal: (companyId: string) =>
    api.get<{ entries: GaiJournalEntry[] }>(`/myrmidon/google-ai-connector/journal?${company(companyId)}`),
};

export const GAI_CAPABILITY_ORDER: GaiCapability[] = ["generate_image", "generate_video", "creative_text"];
