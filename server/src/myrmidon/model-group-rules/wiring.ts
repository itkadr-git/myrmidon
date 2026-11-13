import type { Db } from "@myrmidon/db";
import { secretService } from "../../services/index.js";
import { createLitellmChannelsService } from "../litellm-channels/service.js";
import { modelGroupRulesRoutes } from "./routes.js";

/** Production wiring: the catalog is the current LiteLLM channel model_name list. */
export function myrmidonModelGroupRulesRoutes(db: Db) {
  const secrets = secretService(db);
  const channels = createLitellmChannelsService({
    db,
    readSecretValue: (companyId, secretName) =>
      secrets
        .getByName(companyId, secretName)
        .then((row) => (row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null)),
  });
  return modelGroupRulesRoutes(db, {
    catalog: {
      async listGroups(companyId) {
        const rows = await channels.listChannels(companyId);
        return [...new Set(rows.map((row) => row.modelName))];
      },
    },
  });
}
