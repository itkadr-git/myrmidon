// myrmidon(SETTINGS-UI E2.4): the one place that names the OAuth provider of a tool
// connection. The sign-in flow (tool-access) and the secret settings list both call it, so
// the client secret is always looked up and listed under the same name.
// Leaf module on purpose: tool-access imports the secret settings, not the other way round.

import { badRequest } from "../errors.js";
import { parseRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function remoteEndpointOfConfig(config: Record<string, unknown>): string {
  const value = config.url ?? config.endpoint ?? config.remoteUrl;
  return parseRemoteHttpEndpoint(value, (message, code) => badRequest(message, { code })).toString();
}

/** Explicit provider, then source template key, then the host of the metadata URL or endpoint. */
export function toolOauthProviderForConnection(
  connection: { config: unknown },
  metadataUrl?: string | null,
): string {
  const config = asRecord(connection.config);
  const oauth = asRecord(config.oauth);
  if (typeof oauth.provider === "string" && oauth.provider.trim()) return oauth.provider.trim();
  const sourceTemplateKey = typeof config.sourceTemplateKey === "string" ? config.sourceTemplateKey.trim() : "";
  if (sourceTemplateKey) return sourceTemplateKey;
  const url = metadataUrl ?? remoteEndpointOfConfig(config);
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "generic";
  } catch {
    return "generic";
  }
}

/** The metadata URL a connection persisted itself (a live challenge hint exists only at sign-in). */
export function persistedOauthMetadataUrl(connection: { config: unknown }): string | undefined {
  const value = asRecord(asRecord(connection.config).oauth).metadataUrl;
  return typeof value === "string" ? value : undefined;
}
