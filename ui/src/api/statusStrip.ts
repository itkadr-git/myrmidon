import type { StatusStrip } from "@myrmidon/shared";
import { api } from "./client";

export const statusStripApi = {
  get: (companyId: string) => api.get<StatusStrip>(`/companies/${companyId}/status-strip`),
};
