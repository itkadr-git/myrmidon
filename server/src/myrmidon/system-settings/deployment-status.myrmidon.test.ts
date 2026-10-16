// myrmidon(1.7, OPE-4101, SETTINGS-TO-UI E): tests for the deployment status
// endpoint and the status rows.

import { describe, expect, it } from "vitest";
import { readDeploymentStatus } from "./deployment-status.js";

describe("readDeploymentStatus", () => {
  it("reports not-configured for missing env vars", () => {
    const rows = readDeploymentStatus({} as NodeJS.ProcessEnv);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("not-configured");
      expect(row.detail).toBeNull();
    }
  });

  it("reports configured with host detail for a valid URL", () => {
    const env = { MYRMIDON_LITELLM_BASE_URL: "https://litellm.internal:4000" } as NodeJS.ProcessEnv;
    const rows = readDeploymentStatus(env);
    const litellm = rows.find((r) => r.id === "litellm-base-url");
    expect(litellm?.status).toBe("configured");
    expect(litellm?.detail).toBe("litellm.internal:4000");
  });

  it("reports configured without detail for a flag/secret ref", () => {
    const env = { MYRMIDON_ZABBIX_TOKEN_REF: "zabbix-token" } as NodeJS.ProcessEnv;
    const rows = readDeploymentStatus(env);
    const zabbix = rows.find((r) => r.id === "zabbix-token-ref");
    expect(zabbix?.status).toBe("configured");
    expect(zabbix?.detail).toBeNull();
  });
});
