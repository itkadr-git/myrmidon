// myrmidon(GOOGLE-AI-CONNECT-UI): server-side types for the subscription connector.
//
// The wire contract lives in @paperclipai/shared/myrmidon-google-ai-connector;
// this file adds the error type, the calling-agent identity, and the session
// secret store interface.

export type GoogleAiConnectorStatus = 400 | 401 | 403 | 404 | 409 | 502;

/**
 * A refusal the owner or the agent can act on. `code` is machine-readable
 * (the UI keys its copy on it); `message` is written for the caller and never
 * carries secret material.
 */
export class GoogleAiConnectorError extends Error {
  constructor(
    readonly status: GoogleAiConnectorStatus,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GoogleAiConnectorError";
  }
}

/** Identity of the agent on whose behalf a call runs (mirrors the cloud
 * connector: the board resolved the key, the role labels the caste grants). */
export interface GaiAgentIdentity {
  agentId: string;
  companyId: string | null;
  caste: string | null;
}

/** Where the connector keeps the owner's session bundle: the instance secret
 * store, same rule as the cloud connector's token store. The connector only
 * ever holds the secret id. */
export interface GaiSessionWriteInput {
  companyId: string;
  value: string;
  userId: string;
}

export interface GaiSessionStore {
  write(input: GaiSessionWriteInput): Promise<{ secretId: string; version: number }>;
  /** Read the bundle for the bridge-facing delivery. Value stays inside the
   * server: routes that expose it are token-guarded and never log it. */
  read(companyId: string, secretId: string): Promise<{ value: string; version: number } | null>;
  rotate(companyId: string, secretId: string, value: string): Promise<{ secretId: string; version: number }>;
  remove(companyId: string, secretId: string): Promise<void>;
}
