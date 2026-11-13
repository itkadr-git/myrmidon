import { describe, expect, it } from "vitest";
import {
  createBitrix24Connector,
  createOneCOdataConnector,
  redactConnectorError,
  type ConnectorTransportRequest,
  type ConnectorTransportResponse,
} from "./enterprise-providers.js";

function okResponse(data: unknown): ConnectorTransportResponse {
  return { status: 200, headers: { "content-type": "application/json" }, data };
}

function recordingTransport(
  handler: (request: ConnectorTransportRequest) => ConnectorTransportResponse = () => okResponse([]),
) {
  const calls: ConnectorTransportRequest[] = [];
  const transport = async (request: ConnectorTransportRequest) => {
    calls.push(request);
    return handler(request);
  };
  return Object.assign(transport, { calls });
}

const BASIC_CREDENTIALS = [
  {
    name: "1c_basic",
    secretId: "secret-1c",
    placement: "header" as const,
    key: "authorization",
    prefix: "Basic ",
  },
];

const ONE_C_BASE = "https://1c.example.test/base/odata/InfoBase";
const BITRIX_BASE = "https://example.bitrix24.ru/rest";

describe("1C OData provider", () => {
  it("exposes read-only catalog and document actions with stable ids", () => {
    const provider = createOneCOdataConnector({
      baseUrl: ONE_C_BASE,
      transport: recordingTransport(),
    });
    expect(provider.actions.map((action) => action.id)).toEqual([
      "odata_1c:Catalog_Contractors",
      "odata_1c:Catalog_Products",
      "odata_1c:Document_SalesOrder",
      "odata_1c:Document_PaymentIn",
    ]);
    expect(provider.actions.every((action) => action.method === "GET")).toBe(true);
  });

  it("maps a read call onto the OData URL, options, and headers", async () => {
    const transport = recordingTransport(() =>
      okResponse({ value: [{ Ref_Key: "k1", Description: "Acme" }] }),
    );
    const provider = createOneCOdataConnector({
      baseUrl: `${ONE_C_BASE}/`,
      credentials: BASIC_CREDENTIALS,
      transport,
      resolveSecret: async () => "dXNlcjpwYXNz",
    });

    const result = await provider.call("odata_1c:Catalog_Contractors", {
      query: { $top: 5, $select: "Ref_Key,Description" },
    });

    const call = transport.calls[0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe(
      "https://1c.example.test/base/odata/InfoBase/Catalog_Contractors?$top=5&$select=Ref_Key,Description",
    );
    expect(call.headers.accept).toBe("application/json;odata=nometadata");
    expect(call.headers["odata-version"]).toBe("4.0");
    // Vault secret materializes only inside the outgoing transport call.
    expect(call.headers.authorization).toBe("Basic dXNlcjpwYXNz");
    expect(result.data).toEqual({ value: [{ Ref_Key: "k1", Description: "Acme" }] });
    expect(result.status).toBe(200);
  });

  it("rejects non-OData query options so writes are not expressible", async () => {
    const transport = recordingTransport();
    const provider = createOneCOdataConnector({ baseUrl: ONE_C_BASE, transport });
    await expect(
      provider.call("odata_1c:Catalog_Products", { query: { $method: "POST" } }),
    ).rejects.toThrow("Unknown 1C OData query option: $method");
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects unknown entities and query-placed credentials", () => {
    const transport = recordingTransport();
    const provider = createOneCOdataConnector({ baseUrl: ONE_C_BASE, transport });
    expect(provider.call("odata_1c:Document_Sales")).rejects.toThrow(
      "Unknown 1C OData action",
    );
    expect(() =>
      createOneCOdataConnector({
        baseUrl: ONE_C_BASE,
        credentials: [
          { name: "k", secretId: "s", placement: "query", key: "apikey" },
        ],
        transport,
      }),
    ).toThrow("1C credentials cannot be placed in the query string");
  });

  it("rejects private or reserved literal endpoints at config time", () => {
    for (const base of ["http://127.0.0.1/odata", "http://10.0.0.5/odata", "http://[::1]/odata"]) {
      expect(() => createOneCOdataConnector({ baseUrl: base, transport: recordingTransport() })).toThrow(
        "private or reserved address",
      );
    }
  });

  it("honors the injected endpoint policy per call", async () => {
    const transport = recordingTransport();
    const checked: string[] = [];
    const provider = createOneCOdataConnector({
      baseUrl: ONE_C_BASE,
      transport,
      assertEndpoint: async (url) => {
        checked.push(url.toString());
      },
    });
    await provider.call("odata_1c:Document_PaymentIn");
    expect(checked).toEqual(["https://1c.example.test/base/odata/InfoBase/Document_PaymentIn"]);
  });
});

describe("Bitrix24 provider", () => {
  it("exposes the fixed task/deal/comment action set", () => {
    const provider = createBitrix24Connector({ baseUrl: BITRIX_BASE, transport: recordingTransport() });
    expect(provider.actions.map((action) => action.id)).toEqual([
      "bitrix24:tasks.task.list",
      "bitrix24:tasks.task.get",
      "bitrix24:tasks.task.add",
      "bitrix24:tasks.task.update",
      "bitrix24:tasks.commentitem.getall",
      "bitrix24:crm.deal.list",
      "bitrix24:crm.deal.get",
      "bitrix24:crm.deal.add",
      "bitrix24:crm.deal.update",
      "bitrix24:crm.deal.contact.items.get",
      "bitrix24:crm.timeline.comment.add",
    ]);
  });

  it("maps a task list call onto POST with JSON parameters", async () => {
    const transport = recordingTransport(() =>
      okResponse({
        result: { tasks: [{ id: 5, title: "Ship" }], total: 1 },
        time: {},
      }),
    );
    const provider = createBitrix24Connector({
      baseUrl: BITRIX_BASE,
      credentials: [
        { name: "b24_webhook", secretId: "secret-b24", placement: "header", key: "x-webhook-key" },
      ],
      transport,
      resolveSecret: async () => "wh-secret",
    });

    const result = await provider.call("bitrix24:tasks.task.list", {
      params: { filter: { STATUS: "2" }, select: ["ID", "TITLE"] },
    });

    const call = transport.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://example.bitrix24.ru/rest/tasks.task.list.json");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["x-webhook-key"]).toBe("wh-secret");
    expect(JSON.parse(call.body ?? "{}")).toEqual({
      filter: { STATUS: "2" },
      select: ["ID", "TITLE"],
    });
    expect(result.data).toEqual({ result: { tasks: [{ id: 5, title: "Ship" }], total: 1 }, time: {} });
  });

  it("serializes a comment add with entity binding", async () => {
    const transport = recordingTransport(() => okResponse({ result: 42 }));
    const provider = createBitrix24Connector({ baseUrl: BITRIX_BASE, transport });
    const result = await provider.call("bitrix24:crm.timeline.comment.add", {
      params: { ENTITY_ID: 10, ENTITY_TYPE: "deal", COMMENT: "Follow up" },
    });
    expect(transport.calls[0].url).toBe(
      "https://example.bitrix24.ru/rest/crm.timeline.comment.add.json",
    );
    expect(JSON.parse(transport.calls[0].body ?? "{}")).toEqual({
      ENTITY_ID: 10,
      ENTITY_TYPE: "deal",
      COMMENT: "Follow up",
    });
    expect(result.data).toEqual({ result: 42 });
  });

  it("rejects unknown methods before the transport is reached", async () => {
    const transport = recordingTransport();
    const provider = createBitrix24Connector({ baseUrl: BITRIX_BASE, transport });
    await expect(provider.call("bitrix24:crm.lead.delete")).rejects.toThrow(
      "Unknown Bitrix24 action",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects private or reserved literal endpoints at config time", () => {
    expect(() =>
      createBitrix24Connector({ baseUrl: "http://169.254.169.254/rest", transport: recordingTransport() }),
    ).toThrow("private or reserved address");
  });
});

describe("secret and error safety", () => {
  it("keeps credentials out of the action catalog and runtime errors", async () => {
    const transport = recordingTransport(() => {
      throw new Error(
        'request failed: GET https://1c.example.test/base/odata/InfoBase?authorization=Basic%20abc123 failed',
      );
    });
    const provider = createOneCOdataConnector({
      baseUrl: ONE_C_BASE,
      credentials: BASIC_CREDENTIALS,
      transport,
      resolveSecret: async () => "abc123",
    });
    await expect(provider.call("odata_1c:Catalog_Products")).rejects.toThrow("[REDACTED]");
    await expect(provider.call("odata_1c:Catalog_Products")).rejects.not.toThrow(/abc123/);
  });

  it("redacts credential-looking fragments from transport error text", () => {
    const redacted = redactConnectorError(new Error("bearer sk-live-abc123 rejected upstream"));
    expect(redacted.message).toBe("bearer [REDACTED] rejected upstream");
    expect(redactConnectorError(new Error("api_key=secret-value invalid")).message).toBe(
      "api_key=[REDACTED] invalid",
    );
    expect(redactConnectorError("boom").message).toBe("boom");
  });

  it("fails when credentials are configured without a resolver", async () => {
    const provider = createOneCOdataConnector({
      baseUrl: ONE_C_BASE,
      credentials: BASIC_CREDENTIALS,
      transport: recordingTransport(),
    });
    await expect(provider.call("odata_1c:Catalog_Products")).rejects.toThrow(
      "Credential 1c_basic has no secret resolver",
    );
  });
});
