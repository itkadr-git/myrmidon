import { describe, expect, it } from "vitest";
import { persistedOauthMetadataUrl, toolOauthProviderForConnection } from "./tool-oauth-provider.js";
import { toolOauthProviderSecretSettingName } from "../myrmidon/secret-settings/registry.js";

const base = { url: "https://mcp.endpoint-host.io/v1" };

describe("toolOauthProviderForConnection", () => {
  it("prefers the explicit provider, then the template key, then metadata host, then endpoint host", () => {
    expect(toolOauthProviderForConnection({ config: { ...base, oauth: { provider: "Acme" }, sourceTemplateKey: "t" } })).toBe("Acme");
    expect(toolOauthProviderForConnection({ config: { ...base, sourceTemplateKey: "tmpl" } })).toBe("tmpl");
    const withMeta = { config: { ...base, oauth: { metadataUrl: "https://auth.meta-host.io/x" } } };
    expect(toolOauthProviderForConnection(withMeta, persistedOauthMetadataUrl(withMeta))).toBe("auth_meta_host_io");
    expect(toolOauthProviderForConnection({ config: base })).toBe("mcp_endpoint_host_io");
  });

  it("gives the settings list and the sign-in the same secret name for one connection", () => {
    const connection = { config: { ...base, oauth: { metadataUrl: "https://auth.meta-host.io/x" } } };
    const signIn = toolOauthProviderForConnection(connection, persistedOauthMetadataUrl(connection));
    const listed = toolOauthProviderForConnection(connection, persistedOauthMetadataUrl(connection));
    expect(toolOauthProviderSecretSettingName(listed)).toBe(toolOauthProviderSecretSettingName(signIn));
    expect(toolOauthProviderSecretSettingName(listed)).toBe("tool-oauth.auth_meta_host_io.client-secret");
  });
});
