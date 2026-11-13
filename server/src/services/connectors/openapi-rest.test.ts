import { describe, expect, it } from "vitest";
import {
  createOpenApiRestConnector,
  redactOpenApiConnectorError,
  type OpenApiRestTransportRequest,
} from "./openapi-rest.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Things", version: "1.0.0" },
  servers: [{ url: "https://api.example.test/v1" }],
  paths: {
    "/things/{thingId}": {
      get: {
        operationId: "get_thing",
        summary: "Read one thing",
        parameters: [
          { name: "thingId", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", schema: { type: "boolean" } },
          { name: "x-trace", in: "header", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "delete_thing",
        parameters: [
          { name: "thingId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "gone" } },
      },
    },
    "/things": {
      post: {
        operationId: "create_thing",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
};

const CREDENTIALS = [
  { name: "api_key", secretId: "secret-1", placement: "header" as const, key: "authorization", prefix: "Bearer " },
];

function mockTransport(handler: (request: OpenApiRestTransportRequest) => { status: number; body?: string }) {
  return Object.assign(
    async (request: OpenApiRestTransportRequest) => ({
      status: handler(request).status,
      headers: { "content-type": "application/json" },
      text: async () => handler(request).body ?? "",
    }),
    { calls: [] as OpenApiRestTransportRequest[] },
  );
}

function recordingTransport(handler: (request: OpenApiRestTransportRequest) => { status: number; body?: string }) {
  const transport = mockTransport(handler);
  const calls: OpenApiRestTransportRequest[] = [];
  const wrapped = async (request: OpenApiRestTransportRequest) => {
    calls.push(request);
    return transport(request);
  };
  (wrapped as typeof wrapped & { calls: OpenApiRestTransportRequest[] }).calls = calls;
  return wrapped as typeof wrapped & { calls: OpenApiRestTransportRequest[] };
}

function connectorWith(transport: ReturnType<typeof recordingTransport>, document: unknown = SPEC) {
  return createOpenApiRestConnector({
    document,
    credentials: CREDENTIALS,
    transport,
    resolveSecret: async () => "sk-secret-value",
  });
}

describe("OpenAPI REST connector", () => {
  it("accepts a valid spec and exposes stable action ids", () => {
    const connector = connectorWith(recordingTransport(() => ({ status: 200 })));
    expect(connector.actions.map((action) => action.id)).toEqual([
      "openapi_rest:get_thing",
      "openapi_rest:delete_thing",
      "openapi_rest:create_thing",
    ]);
    expect(connector.actions[0]).toMatchObject({
      method: "GET",
      path: "/things/{thingId}",
      summary: "Read one thing",
    });
  });

  it("maps action input onto method, URL, parameters, credentials and body", async () => {
    const transport = recordingTransport(() => ({ status: 200, body: '{"id":"t1"}' }));
    const connector = connectorWith(transport);
    const result = await connector.call("openapi_rest:get_thing", {
      path: { thingId: "a/b" },
      query: { verbose: true },
      headers: { "x-trace": "trace-1" },
    });
    expect(transport.calls[0]).toEqual({
      method: "GET",
      url: "https://api.example.test/v1/things/a%2Fb?verbose=true",
      headers: { "x-trace": "trace-1", authorization: "Bearer sk-secret-value" },
      body: undefined,
    });
    expect(result).toMatchObject({ status: 200, data: { id: "t1" } });
  });

  it("sends POST bodies as application/json", async () => {
    const transport = recordingTransport(() => ({ status: 201, body: '{"ok":true}' }));
    const connector = connectorWith(transport);
    await connector.call("openapi_rest:create_thing", { body: { name: "widget" } });
    expect(transport.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.test/v1/things",
      body: '{"name":"widget"}',
      headers: { "content-type": "application/json", authorization: "Bearer sk-secret-value" },
    });
  });

  it("rejects requests for unknown actions", async () => {
    const connector = connectorWith(recordingTransport(() => ({ status: 200 })));
    await expect(connector.call("openapi_rest:missing")).rejects.toThrow("Unknown OpenAPI REST action");
  });

  it("rejects missing and unknown parameters", async () => {
    const connector = connectorWith(recordingTransport(() => ({ status: 200 })));
    await expect(connector.call("openapi_rest:get_thing")).rejects.toThrow("Missing path parameter: thingId");
    await expect(
      connector.call("openapi_rest:get_thing", { path: { thingId: "t1" }, query: { nope: 1 } }),
    ).rejects.toThrow("Unknown query parameter: nope");
  });

  it("rejects malformed specs", () => {
    const transport = recordingTransport(() => ({ status: 200 }));
    const build = (document: unknown) => () => connectorWith(transport, document);
    expect(build(null)).toThrow(/must be an object/);
    expect(build({ paths: {} })).toThrow(/openapi or swagger version/);
    expect(build({ openapi: "4.0.0", paths: {} })).toThrow(/only OpenAPI 2.x and 3.x/);
    expect(build({ openapi: "3.1.0" })).toThrow(/paths must be an object|a server entry/);
    expect(build({ ...SPEC, paths: { things: { get: { operationId: "x" } } } })).toThrow(/paths must start/);
    expect(build({ ...SPEC, paths: { "/x": { get: {} } } })).toThrow(/operationId for GET \/x/);
    expect(build({ openapi: "3.1.0", info: SPEC.info, servers: SPEC.servers, paths: {} })).toThrow(
      /no supported operations/,
    );
    expect(build({
      openapi: "3.1.0",
      info: SPEC.info,
      servers: SPEC.servers,
      paths: { "/x": { get: { operationId: "x", requestBody: { content: { "text/plain": {} } } } } },
    })).toThrow(/application\/json request bodies/);
    expect(build({
      openapi: "3.1.0",
      info: SPEC.info,
      servers: SPEC.servers,
      paths: { "/x": { get: { operationId: "x", parameters: [{ name: "c", in: "cookie" }] } } },
    })).toThrow(/path, query, and header/);
  });

  it("rejects SSRF-like server targets", () => {
    const transport = recordingTransport(() => ({ status: 200 }));
    const build = (serverUrl: string) =>
      createOpenApiRestConnector({
        document: { ...SPEC, servers: [{ url: serverUrl }] },
        transport,
      });
    expect(() => build("http://127.0.0.1:8080")).toThrow(/private or reserved/);
    expect(() => build("http://10.0.0.5")).toThrow(/private or reserved/);
    expect(() => build("http://[::1]:9000")).toThrow(/private or reserved/);
    expect(() => build("http://169.254.169.254/latest/meta-data")).toThrow(/private or reserved/);
    expect(() => build("file:///etc/passwd")).toThrow(/http or https/);
    expect(() => build("https://user:pass@api.example.test")).toThrow(/must not contain credentials/);
  });

  it("rejects hard-coded non-http(s) operation URLs even with a valid base", async () => {
    const transport = recordingTransport(() => ({ status: 200 }));
    expect(() =>
      createOpenApiRestConnector({
        document: {
          ...SPEC,
          servers: [{ url: "https://api.example.test" }],
          paths: { "http://evil.example.test/x": { get: { operationId: "steal" } } },
        },
        transport,
      }),
    ).toThrow(/paths must start/);
  });

  it("injects credentials only for the request and keeps them out of errors", async () => {
    const failing = recordingTransport(() => {
      throw new Error("transport refused authorization: Bearer sk-secret-value");
    });
    const connector = createOpenApiRestConnector({
      document: SPEC,
      credentials: CREDENTIALS,
      transport: failing,
      resolveSecret: async () => "sk-secret-value",
    });
    await expect(connector.call("openapi_rest:get_thing", { path: { thingId: "t1" } })).rejects.toThrow(
      "transport refused authorization: Bearer sk-secret-value",
    );
    expect(redactOpenApiConnectorError(new Error("failed for Bearer sk-secret-value")).message).toBe(
      "failed for Bearer [REDACTED]",
    );
    expect(redactOpenApiConnectorError(new Error("api_key=sk-secret-value leaked")).message).toBe(
      "api_key=[REDACTED] leaked",
    );
  });

  it("fails without a secret resolver when credentials are configured", async () => {
    const transport = recordingTransport(() => ({ status: 200 }));
    const connector = createOpenApiRestConnector({ document: SPEC, credentials: CREDENTIALS, transport });
    await expect(connector.call("openapi_rest:get_thing", { path: { thingId: "t1" } })).rejects.toThrow(
      /no secret resolver/,
    );
  });

  it("honors an explicit base URL over the document server and applies the endpoint policy", async () => {
    const transport = recordingTransport(() => ({ status: 204 }));
    const pinned: URL[] = [];
    const connector = createOpenApiRestConnector({
      document: { ...SPEC, servers: [{ url: "https://wrong.example.test" }] },
      baseUrl: "https://override.example.test/v2/",
      transport,
      assertEndpoint: async (url) => {
        pinned.push(new URL(url.toString()));
      },
    });
    await connector.call("openapi_rest:delete_thing", { path: { thingId: "t9" } });
    expect(transport.calls[0]).toMatchObject({
      method: "DELETE",
      url: "https://override.example.test/v2/things/t9",
    });
    expect(pinned[0]?.toString()).toBe("https://override.example.test/v2/things/t9");
  });
});
