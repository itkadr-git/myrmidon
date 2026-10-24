// myrmidon(LICENSING): client licensing API (instance admin only):
//   GET  /api/licensing/status   install id, license request blob, license state per closed module
//   POST /api/licensing/license  { value } save a license where the modules read it
// Issuing licenses is the vendor's side and is not part of this screen.
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { api } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";

export const LICENSE_MODULES = ["google-ai", "antigravity", "chatgpt-pool"] as const;
export type LicenseModule = (typeof LICENSE_MODULES)[number];

export const LICENSES_PATH = `${INSTANCE_SETTINGS_PATH_PREFIX}/licenses`;

export type ModuleLicenseState =
  | "valid"
  | "expiring"
  | "expired"
  | "wrong_instance"
  | "missing"
  | "not_granted"
  | "bad_signature"
  | "invalid";

export interface ModuleLicenseStatus {
  module: string;
  installed: boolean;
  state: ModuleLicenseState;
  reason: string;
  expires: number | null;
  /** `wrong_instance` only: the installation id the license was issued for. */
  licenseInstanceId?: string;
  /** `wrong_instance` only: the installation id of this board. */
  boardInstanceId?: string;
  message?: string;
}

export interface LicensingStatus {
  installId: string;
  source: "env" | "machine-id" | "generated";
  board: string;
  knownModules: string[];
  installedModules: string[];
  request: string;
  license: {
    source: "env" | "file" | "none" | "file-error";
    path: string;
    envOverride: boolean;
    share: "host" | "mounted" | "container-only";
  };
  modules: ModuleLicenseStatus[];
  attention: boolean;
}

export const licensingStatusQueryKey = ["myrmidon", "licensing", "status"] as const;

export const licensingApi = {
  status: (modules?: readonly string[]) =>
    api.get<LicensingStatus>(
      modules && modules.length > 0 ? `/licensing/status?modules=${modules.join(",")}` : "/licensing/status",
    ),
  saveLicense: (value: string) => api.post<LicensingStatus>("/licensing/license", { value }),
};

/**
 * The screen and the banner are for the instance admin only; others never
 * call the licensing API. `null` while the access answer is not known yet.
 */
export function useIsInstanceAdmin(): boolean | null {
  const { data, isError } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  if (isError) return false;
  if (!data) return null;
  return Boolean(data.isInstanceAdmin || data.source === "local_implicit");
}

export function formatLicenseDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
