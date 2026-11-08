// server/src/myrmidon/github-shared-identity/vendor-connector.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): the instance-wide switch of the vendor's
// cloud GitHub connector.
//
// The vendor's managed GitHub method routes OAuth through the vendor's cloud
// connector and the vendor's GitHub App: installing it hands a third party
// write access to the repositories. Our builds use self-hosted GitHub Apps
// instead, so the vendor path is OFF unless an operator turns it on with
// `MYRMIDON_GITHUB_VENDOR_CONNECTOR=1`. While off:
//   - new managed GitHub connections and their OAuth start are refused;
//   - existing vendor-connector GitHub connections are ignored by the
//     credential resolver (shell git/gh, the run broker, workspace git).
// Read on every call: changing the variable needs only a process restart.

import { unprocessable } from "../../errors.js";

export const GITHUB_VENDOR_CONNECTOR_ENV = "MYRMIDON_GITHUB_VENDOR_CONNECTOR";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function vendorGitHubConnectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GITHUB_VENDOR_CONNECTOR_ENV];
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

/** A GitHub connection whose OAuth goes through the vendor's cloud connector. */
export function isVendorCloudGitHubConnection(connection: { config?: unknown; transportConfig?: unknown }): boolean {
  const config = connection.config && typeof connection.config === "object" ? (connection.config as Record<string, unknown>) : {};
  const oauth = config.oauth && typeof config.oauth === "object" ? (config.oauth as Record<string, unknown>) : {};
  return oauth.strategy === "paperclip_cloud_connector" || oauth.connectorProfile === "github.code";
}

export const VENDOR_GITHUB_CONNECTOR_DISABLED_MESSAGE =
  "The vendor cloud GitHub connector is disabled on this instance; use a self-hosted GitHub App (Company settings → Shared GitHub authorization)";

/** Refuse the vendor's GitHub connector profile while it is switched off. */
export function assertVendorGitHubConnectorAllowed(profileId: string, env: NodeJS.ProcessEnv = process.env) {
  if (profileId === "github.code" && !vendorGitHubConnectorEnabled(env)) {
    throw unprocessable(VENDOR_GITHUB_CONNECTOR_DISABLED_MESSAGE, { code: "github_vendor_connector_disabled" });
  }
}
