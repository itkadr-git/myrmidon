// Maintenance window cron validator API client (1.7 AUTO-UPDATE-SETTINGS, OPE-10185).
import { api } from "@/api/client";
import type {
  MaintenanceWindowCronValidationResult,
  ValidateMaintenanceWindowCronRequest,
} from "@myrmidon/shared";

export const maintenanceWindowCronApi = {
  validate: (input: ValidateMaintenanceWindowCronRequest) =>
    api.post<MaintenanceWindowCronValidationResult>(
      "/instance/maintenance-window/validate-cron",
      input,
    ),
};
