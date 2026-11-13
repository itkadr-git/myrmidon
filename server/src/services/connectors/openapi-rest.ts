// 1.8 ENTERPRISE-CONNECTORS (OPE-13028): generic REST connector configured
// from an OpenAPI document. Pure module — no database, no real network: the
// caller injects the transport (mock in tests, guarded fetch in production)
// and a secret resolver that materializes vault credential references only
// for the duration of the request. Secrets are never written to logs or
// thrown errors; error text goes through redactOpenApiConnectorError before
// it may reach an agent or the activity journal.
//
// Scope guards (per the task boundary):
// - schemes: only absolute http/https base URL + operation paths;
// - unsafe targets: private/reserved literal IPs rejected at parse time,
//   every runtime URL re-checked by the injected endpoint policy (the
//   production caller passes the repo SSRF guard with DNS pinning);
// - requests outside the configured base URL are impossible: the URL is
//   always built from baseUrl + the spec path, never from caller input.

import { isIP } from "node:net";
import { isPrivateOrReservedIp } from "../remote-http-endpoint-guard.js";

const SUPPORTED_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

/**
 * Stable action id contract, coordinated with OPE-13019's catalog: the
 * namespace is `openapi_rest`, the operation part is the spec `operationId`,
 * so ids stay stable across re-publishes of the same document.
 */
const ACTION_ID_PREFIX = "openapi_rest";

export interface OpenApiRestCredentialRef {
  readonly name: string;
  readonly secretId: string;
  readonly placement: "header" | "query";
  readonly key: string;
  readonly prefix?: string;
}

export interface OpenApiRestTransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface OpenApiRestTransportResponse {
  readonly text: () => Promise<string>;
}

export type OpenApiRestTransport = (
  request: OpenApiRestTransportRequest,
) => Promise<OpenApiRestTransportResponse>;

export type OpenApiRestSecretResolver = (
  ref: OpenApiRestCredentialRef,
) => Promise<string>;

export interface OpenApiRestConnectorOptions {
  readonly document: unknown;
  /** Overrides the document's first server entry when provided. */
  readonly baseUrl?: string;
  readonly credentials?: readonly OpenApiRestCredentialRef[];
  readonly transport: OpenApiRestTransport;
  readonly resolveSecret?: OpenApiRestSecretResolver;
  /** Async endpoint policy (repo SSRF guard). Throws for unapproved URLs. */
  readonly assertEndpoint?: (url: URL) => Promise<void>;
}

export interface OpenApiRestAction {
  readonly id: string;
  readonly operationId: string;
  readonly method: Uppercase<SupportedMethod>;
  readonly path: string;
  readonly summary: string;
  readonly parameters: readonly OpenApiRestParameter[];
  readonly requestBody?: OpenApiRestRequestBody;
}

export interface OpenApiRestParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
}

export interface OpenApiRestRequestBody {
  readonly required: boolean;
  readonly contentType: string;
}

export interface OpenApiRestCallInput {
  readonly path?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

export interface OpenApiRestCallResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: unknown;
}

export interface OpenApiRestConnector {
  readonly actions: readonly OpenApiRestAction[];
  call(actionId: string, input?: OpenApiRestCallInput): Promise<OpenApiRestCallResult>;
}

type RawDocument = {
  openapi?: unknown;
  swagger?: unknown;
  servers?: unknown;
  basePath?: unknown;
  paths?: unknown;
};

type RawOperation = Record<string, unknown>;

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

function fail(message: string): never {
  throw new Error(`Invalid OpenAPI REST connector: ${message}`);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseDocument(document: unknown): RawDocument {
  let value = document;
  if (typeof document === "string") {
    try {
      value = JSON.parse(document);
    } catch {
      fail("document must be valid JSON (YAML is not supported)");
    }
  }
  const parsed = asObject(value, "document") as RawDocument;
  if (typeof parsed.openapi !== "string" && typeof parsed.swagger !== "string") {
    fail("openapi or swagger version is required");
  }
  const version = String(parsed.openapi ?? parsed.swagger);
  if (!(version.startsWith("3.") || version.startsWith("2."))) {
    fail("only OpenAPI 2.x and 3.x documents are supported");
  }
  asObject(parsed.paths, "paths");
  return parsed;
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
  if (url.hash) fail(`${label} must not contain a fragment`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isPrivateOrReservedIp(host)) {
    fail(`${label} targets a private or reserved address`);
  }
  return url;
}

function normalizeBaseUrl(value: string): string {
  const url = validateEndpoint(value, "base URL");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function operationParameters(raw: RawOperation): OpenApiRestParameter[] {
  const params = raw.parameters === undefined ? [] : raw.parameters;
  if (!Array.isArray(params)) fail("operation parameters must be an array");
  return params.map((parameter) => {
    const entry = asObject(parameter, "parameter");
    if (
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !["path", "query", "header"].includes(String(entry.in))
    ) {
      fail("only path, query, and header parameters are supported");
    }
    return {
      name: entry.name,
      in: entry.in as OpenApiRestParameter["in"],
      required: entry.required === true || entry.in === "path",
    };
  });
}

function operationRequestBody(raw: RawOperation): OpenApiRestRequestBody | undefined {
  if (raw.requestBody === undefined) return undefined;
  const body = asObject(raw.requestBody, "requestBody");
  const content = asObject(body.content, "requestBody.content");
  const types = Object.keys(content);
  if (types.length !== 1 || types[0] !== "application/json") {
    fail("only application/json request bodies are supported");
  }
  return { required: body.required === true, contentType: types[0] };
}

function resolveBaseUrl(document: RawDocument, override?: string): string {
  if (override) return normalizeBaseUrl(override);
  if (Array.isArray(document.servers) && document.servers.length > 0) {
    const server = asObject(document.servers[0], "server");
    if (typeof server.url !== "string") fail("server URL is required");
    return normalizeBaseUrl(server.url);
  }
  if (typeof document.basePath === "string") {
    // Swagger 2: host is deployment-specific, so the caller must supply a
    // base URL; without one there is no safe origin to pin requests to.
    fail("a swagger 2 document requires an explicit base URL");
  }
  fail("the document has no server entry; pass a base URL");
}

function encodeParameterValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function headerValueMap(
  headers: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key, encodeParameterValue(value)]),
  );
}

/** Strip anything that looks like a credential from error text. */
export function redactOpenApiConnectorError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "request failed";
  return new Error(
    message.replace(
      /(bearer\s+|api[-_]?key[=:]\s*|authorization[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    ),
  );
}

export function createOpenApiRestConnector(
  options: OpenApiRestConnectorOptions,
): OpenApiRestConnector {
  const document = parseDocument(options.document);
  const baseUrl = resolveBaseUrl(document, options.baseUrl);
  const pathMap = asObject(document.paths, "paths");
  const actions: OpenApiRestAction[] = [];
  for (const [path, pathValue] of Object.entries(pathMap)) {
    if (!path.startsWith("/")) fail("paths must start with /");
    const pathItem = asObject(pathValue, `path ${path}`);
    for (const method of SUPPORTED_METHODS) {
      const raw = pathItem[method];
      if (raw === undefined) continue;
      const operation = asObject(raw, `${method.toUpperCase()} ${path}`);
      if (
        typeof operation.operationId !== "string" ||
        !OPERATION_ID_PATTERN.test(operation.operationId)
      ) {
        fail(`operationId for ${method.toUpperCase()} ${path} is required and must be a safe name`);
      }
      actions.push({
        id: `${ACTION_ID_PREFIX}:${operation.operationId}`,
        operationId: operation.operationId,
        method: method.toUpperCase() as Uppercase<SupportedMethod>,
        path,
        summary:
          typeof operation.summary === "string"
            ? operation.summary
            : typeof operation.description === "string"
              ? operation.description
              : operation.operationId,
        parameters: operationParameters(operation),
        requestBody: operationRequestBody(operation),
      });
    }
  }
  if (actions.length === 0) fail("the document contains no supported operations");
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const credentials = options.credentials ?? [];

  return {
    actions,

    async call(actionId, input = {}) {
      const action = actionById.get(actionId);
      if (!action) throw new Error(`Unknown OpenAPI REST action: ${actionId}`);

      const pathValues = input.path ?? {};
      const pathname = action.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        if (!(name in pathValues)) throw new Error(`Missing path parameter: ${name}`);
        return encodeURIComponent(encodeParameterValue(pathValues[name]));
      });
      const url = new URL(`${baseUrl}${pathname}`);

      const queryValues = input.query ?? {};
      for (const parameter of action.parameters) {
        if (parameter.in !== "query") continue;
        if (parameter.name in queryValues) {
          url.searchParams.set(parameter.name, encodeParameterValue(queryValues[parameter.name]));
        } else if (parameter.required) {
          throw new Error(`Missing query parameter: ${parameter.name}`);
        }
      }
      for (const key of Object.keys(queryValues)) {
        const declared = action.parameters.some(
          (parameter) => parameter.in === "query" && parameter.name === key,
        );
        if (!declared) throw new Error(`Unknown query parameter: ${key}`);
      }

      const headerValues = headerValueMap(input.headers);
      for (const parameter of action.parameters) {
        if (parameter.in !== "header" || parameter.name in headerValues) continue;
        if (parameter.required) {
          throw new Error(`Missing header parameter: ${parameter.name}`);
        }
      }

      // Credential references materialize only here, only for this request,
      // and only into the outgoing transport call — never into the action
      // catalog, error messages, or logs.
      for (const ref of credentials) {
        if (!options.resolveSecret) {
          throw new Error(`Credential ${ref.name} has no secret resolver`);
        }
        const secret = await options.resolveSecret(ref);
        const value = `${ref.prefix ?? ""}${secret}`;
        if (ref.placement === "header") headerValues[ref.key] = value;
        else url.searchParams.set(ref.key, value);
      }

      await options.assertEndpoint?.(url);

      const headers: Record<string, string> = { ...headerValues };
      const body = input.body === undefined ? undefined : JSON.stringify(input.body);
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await options.transport({
        method: action.method,
        url: url.toString(),
        headers,
        body,
      });
      const text = await response.text();
      let data: unknown = text;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          // Plain-text responses stay strings.
        }
      }
      return { status: response.status, headers: response.headers ?? {}, data };
    },
  };
}
