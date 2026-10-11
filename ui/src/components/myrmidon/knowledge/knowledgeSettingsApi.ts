// ui/src/components/myrmidon/knowledge/knowledgeSettingsApi.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-11): the client of "Settings → Knowledge".
// The wire shape is the shared contract, so the screen and the server cannot
// drift on the badge or the bounds.
//
//   GET   /api/myrmidon/companies/:companyId/knowledge/settings
//   PATCH /api/myrmidon/companies/:companyId/knowledge/settings

import { api } from "@/api/client";
import type { KnowledgeSettingsPatch, KnowledgeSettingsView } from "@paperclipai/shared";

export function knowledgeSettingsPath(companyId: string): string {
  return `/api/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge/settings`;
}

export function fetchKnowledgeSettings(companyId: string): Promise<KnowledgeSettingsView> {
  return api.get<KnowledgeSettingsView>(knowledgeSettingsPath(companyId));
}

export function patchKnowledgeSettings(
  companyId: string,
  patch: KnowledgeSettingsPatch,
): Promise<KnowledgeSettingsView> {
  return api.patch<KnowledgeSettingsView>(knowledgeSettingsPath(companyId), patch);
}
