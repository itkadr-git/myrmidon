// 1.8 ENTERPRISE-CONNECTORS (OPE-13027): built-in providers for 1C:Enterprise
// OData (read-only catalogs and documents) and Bitrix24 REST (tasks, deals,
// comments). Pure modules — no database, no real network: the caller injects
// the transport (mock in tests, guarded fetch in production) and a secret
// resolver that materializes vault credential references only for the duration
// of the request. Secrets are never written to logs or thrown errors; error
// text goes through redactConnectorError before it may reach an agent or the
// activity journal.
//
// Scope guards (per the task boundary):
// - 1C is read-only: every action is a GET against a fixed entity feed and
//   only OData $-options are accepted, so write requests are not expressible;
// - Bitrix24 actions are the fixed task/deal/comment set, called with POST
//   + JSON parameters per the Bitrix24 REST convention;
// - private/reserved literal IPs are rejected at parse time and every runtime
//   URL is re-checked by the injected endpoint policy (the production caller
//   passes the repo SSRF guard with DNS pinning);
// - action ids are stable and coordinate with OPE-13019's catalog:
//   `odata_1c:<entity>` and `bitrix24:<method>`.

import { isIP } from "node:net";
import { isPrivateOrReservedIp } from "../remote-http-endpoint-guard.js";

/** Strips anything that looks like a credential from error text. */
export function redactConnectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "request failed";
  return new Error(
    message.replace(
      /(bearer\s+|api[-_]?key[=:]\s*|authorization[=:]\s*|token[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    ),
  );
}

export interface ConnectorCredentialRef {
  readonly name: string;
  readonly secretId: string;
  readonly placement: "header" | "query";
  readonly key: string;
  readonly prefix?: string;
}

export interface ConnectorTransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface ConnectorTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: unknown;
}

export type ConnectorTransport = (
  request: ConnectorTransportRequest,
) => Promise<ConnectorTransportResponse>;

export type ConnectorSecretResolver = (ref: ConnectorCredentialRef) => Promise<string>;

export interface ConnectorAction {
  readonly id: string;
  readonly method: "GET" | "POST";
  readonly summary: string;
  /** Path appended to the base URL; caller input never reaches the origin. */
  readonly path: string;
}

export interface ConnectorCallResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: unknown;
}

function fail(message: string): never {
  throw new Error(`Invalid connector config: ${message}`);
}


function validateEndpoint(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(`${label} must use http or https`);
  }
  if (url.username || url.password) fail(`${label} must not contain credentials`);
  if (url.search) fail(`${label} must not contain a query string`);
  if (url.hash) fail(`${label} must not contain a fragment`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isPrivateOrReservedIp(host)) {
    fail(`${label} targets a private or reserved address`);
  }
  return url;
}

function normalizeBaseUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return validateEndpoint(value, label).toString().replace(/\/$/, "");
}

/** Materialize vault credential refs into the outgoing request only. */
function applyCredentials(
  refs: readonly ConnectorCredentialRef[],
  resolveSecret: ConnectorSecretResolver | undefined,
  headers: Record<string, string>,
  url: URL,
): Promise<void> {
  return Promise.all(
    refs.map(async (ref) => {
      if (!resolveSecret) fail(`credential ${ref.name} has no secret resolver`);
      const value = `${ref.prefix ?? ""}${await resolveSecret(ref)}`;
      if (ref.placement === "header") headers[ref.key.toLowerCase()] = value;
      else url.searchParams.set(ref.key, value);
    }),
  ).then(() => undefined);
}

interface ProviderOptionsBase {
  readonly credentials?: readonly ConnectorCredentialRef[];
  readonly transport: ConnectorTransport;
  readonly resolveSecret?: ConnectorSecretResolver;
  /** Async endpoint policy (repo SSRF guard). Throws for unapproved URLs. */
  readonly assertEndpoint?: (url: URL) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 1C:Enterprise OData (read-only)
// ---------------------------------------------------------------------------

const ODATA_ACTION_ID_PREFIX = "odata_1c";

/**
 * OData system query options a read call may pass. Everything else is
 * rejected, so the provider cannot be used to mutate 1C data.
 */
const ODATA_QUERY_OPTIONS = ["$filter", "$select", "$top", "$skip", "$orderby", "$expand"] as const;

/**
 * Shared tail for both providers: credentials materialize only inside the
 * outgoing transport call, and any transport failure comes back through
 * redactConnectorError so credential text can never reach agents or the
 * activity journal.
 */
async function dispatchConnectorRequest(
  core: Pick<ProviderOptionsBase, "credentials" | "resolveSecret" | "assertEndpoint" | "transport">,
  url: URL,
  headers: Record<string, string>,
  request: { readonly method: "GET" | "POST"; readonly body?: string },
): Promise<ConnectorCallResult> {
  await applyCredentials(core.credentials ?? [], core.resolveSecret, headers, url);
  await core.assertEndpoint?.(url);
  try {
    return await core.transport({
      method: request.method,
      url: url.toString(),
      headers,
      body: request.body,
    });
  } catch (error) {
    throw redactConnectorError(error);
  }
}

/** Catalog/document entity types exposed by default (1C OData naming). */
const DEFAULT_ONE_C_ENTITIES = [
  "Catalog_Contractors",
  "Catalog_Products",
  "Document_SalesOrder",
  "Document_PaymentIn",
] as const;

export interface OneCOdataOptions extends ProviderOptionsBase {
  /** 1C OData service root, e.g. `https://1c.example.test/base/odata/InfoBase`. */
  readonly baseUrl: string;
  /** Entity types to expose; defaults to the common catalog/document set. */
  readonly entities?: readonly string[];
}

export interface OneCOdataConnector {
  readonly actions: readonly ConnectorAction[];
  call(actionId: string, input?: OneCOdataCallInput): Promise<ConnectorCallResult>;
}

export interface OneCOdataCallInput {
  readonly query?: Readonly<Record<string, unknown>>;
}

export function createOneCOdataConnector(options: OneCOdataOptions): OneCOdataConnector {
  const baseUrl = normalizeBaseUrl(options.baseUrl, "base URL");
  if (options.credentials?.some((ref) => ref.placement === "query")) {
    // 1C uses HTTP Basic auth; a credential in the URL would leak through
    // access logs on the application server.
    fail("1C credentials cannot be placed in the query string");
  }
  const entities = options.entities ?? DEFAULT_ONE_C_ENTITIES;
  if (entities.length === 0) fail("at least one entity type is required");

  const actions: readonly ConnectorAction[] = entities.map((entity) => ({
    id: `${ODATA_ACTION_ID_PREFIX}:${entity}`,
    method: "GET" as const,
    summary: `Read ${entity} entities (1C OData feed, read-only)`,
    path: entity,
  }));
  const actionById: Record<string, ConnectorAction> = Object.fromEntries(
    actions.map((action) => [action.id, action]),
  );

  return {
    actions,

    async call(actionId, input = {}) {
      const action = actionById[actionId];
      // URLSearchParams form-encodes `$` (%24) and spaces (+); 1C OData
      // endpoints expect the literal `$option` names and %20 spaces.
      const queryPairs = Object.entries(input.query ?? {}).map(([key, value]) => {
        if (!(ODATA_QUERY_OPTIONS as readonly string[]).includes(key)) {
          throw new Error(`Unknown 1C OData query option: ${key}`);
        }
        const raw =
          typeof value === "string"
            ? value
            : typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : JSON.stringify(value);
        return `${key}=${encodeURIComponent(raw).replace(/%24/g, "$")}`;
      });
      const queryString = queryPairs.length > 0 ? `?${queryPairs.join("&")}` : "";
      const url = new URL(`${baseUrl}/${action.path}${queryString}`);

      const headers: Record<string, string> = {
        accept: "application/json;odata=nometadata",
        // 1C pins the OData protocol version on every request.
        "odata-version": "4.0",
        "maxdataserviceversion": "4.0",
      };
      return dispatchConnectorRequest(options, url, headers, { method: "GET" });
    },
  };
}

// ---------------------------------------------------------------------------
// Bitrix24 REST (tasks, deals, comments)
// ---------------------------------------------------------------------------

const BITRIX24_ACTION_ID_PREFIX = "bitrix24";

/** Fixed task/deal/comment action set (the task boundary). */
const BITRIX24_METHODS = {
  "tasks.task.list": "List tasks",
  "tasks.task.get": "Read one task",
  "tasks.task.add": "Create a task",
  "tasks.task.update": "Update a task",
  "tasks.commentitem.getall": "List task comments",
  "crm.deal.list": "List deals",
  "crm.deal.get": "Read one deal",
  "crm.deal.add": "Create a deal",
  "crm.deal.update": "Update a deal",
  "crm.deal.contact.items.get": "Read deal contacts",
  "crm.timeline.comment.add": "Add a timeline comment",
} as const satisfies Record<string, string>;

export interface Bitrix24Options extends ProviderOptionsBase {
  /** Bitrix24 REST root, e.g. `https://example.bitrix24.ru/rest`. */
  readonly baseUrl: string;
}

export interface Bitrix24Connector {
  readonly actions: readonly ConnectorAction[];
  call(actionId: string, input?: Bitrix24CallInput): Promise<ConnectorCallResult>;
}

export interface Bitrix24CallInput {
  /** Bitrix24 method parameters, e.g. `{ filter: { STATUS: "2" } }`. */
  readonly params?: Readonly<Record<string, unknown>>;
}

export function createBitrix24Connector(options: Bitrix24Options): Bitrix24Connector {
  const baseUrl = normalizeBaseUrl(options.baseUrl, "base URL");

  const actions: readonly ConnectorAction[] = Object.entries(BITRIX24_METHODS).map(
    ([method, summary]) => ({
      // Dots stay in the path: Bitrix24 serves `/rest/<method>.json`.
      id: `${BITRIX24_ACTION_ID_PREFIX}:${method}`,
      method: "POST" as const,
      summary,
      path: `${method}.json`,
    }),
  );
  const actionById: Record<string, ConnectorAction> = Object.fromEntries(
    actions.map((action) => [action.id, action]),
  );

  return {
    actions,

    async call(actionId, input = {}) {
      const action = actionById[actionId];
      if (!action) throw new Error(`Unknown Bitrix24 action: ${actionId}`);

      const url = new URL(`${baseUrl}/${action.path}`);
      const headers: Record<string, string> = { accept: "application/json" };
      return dispatchConnectorRequest(options, url, headers, {
        method: "POST",
        body: JSON.stringify(input.params ?? {}),
      });
    },
  };
}
