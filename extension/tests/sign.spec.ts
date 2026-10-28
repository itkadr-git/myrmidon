import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  executeAction,
  type ActionContext,
  type BrowserTabPort,
  type ConfirmationPort,
  type ContentScriptPort,
  type DownloadedFile,
} from "../src/actions";
import {
  createNativeSignHelper,
  createSignatureStash,
  type SignHelperOutcome,
  type SignHelperPort,
  type SignHelperRequest,
} from "../src/sign";

const CONTEXT: ActionContext = {
  allowlist: ["tender.example"],
  capabilities: ["open", "read", "click", "fill", "download", "screenshot", "sign"],
};
const DOC_URL = "https://tender.example/files/application.pdf";
const BYTES_B64 = "AAECAw==";
const SHA = createHash("sha256").update(Buffer.from(BYTES_B64, "base64")).digest("hex");
const SIGN = { url: DOC_URL, documentRef: "workspace/docs/application.pdf", actionType: "sign" };

function tabs(url = "https://tender.example/lot/1"): BrowserTabPort {
  return {
    async queryActiveTab() {
      return { tabId: 1, url };
    },
    async createTab(u) {
      return { tabId: 2, url: u };
    },
    async updateTabUrl(tabId, u) {
      return { tabId, url: u };
    },
    async captureVisibleTab() {
      return "";
    },
  };
}

function content(file: Partial<DownloadedFile> = {}): ContentScriptPort {
  return {
    async readPage() {
      return "";
    },
    async clickElement() {
      return true;
    },
    async fillElement() {
      return true;
    },
    async downloadFile() {
      return { name: "a.pdf", mimeType: "application/pdf", byteLength: 4, base64: BYTES_B64, ...file };
    },
  };
}

/** A stand-in for the helper: records requests, answers with a canned outcome. */
function helper(outcome: SignHelperOutcome): { port: SignHelperPort; requests: SignHelperRequest[] } {
  const requests: SignHelperRequest[] = [];
  return {
    requests,
    port: {
      async sign(request) {
        requests.push(request);
        return outcome;
      },
    },
  };
}

const sha256Hex = async (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

describe("browser.sign", () => {
  it("fetches the document in the page session, signs through the helper and reports status and digest only", async () => {
    const h = helper({ ok: true, hash: "a".repeat(64), signatureBase64: "U0lH" });
    const stash = createSignatureStash();
    const outcome = await executeAction("browser.sign", { ...SIGN, confirmation: "none" }, CONTEXT, {
      tabs: tabs(),
      content: content(),
      sign: { helper: h.port, stash, sha256Hex },
    });
    expect(outcome).toEqual({ ok: true, result: { status: "signed", documentHash: "a".repeat(64) } });
    expect(h.requests).toEqual([{ actionType: "sign", documentRef: SIGN.documentRef, bytesBase64: BYTES_B64 }]);
    // The signature stays on this PC and is not part of the bridge result.
    expect(JSON.stringify(outcome)).not.toContain("U0lH");
    expect(stash.take("a".repeat(64))).toBe("U0lH");
    expect(stash.take("a".repeat(64))).toBeNull();
  });

  it("auto mode signs without asking a person", async () => {
    const asked: unknown[] = [];
    const confirm: ConfirmationPort = {
      async request(prompt) {
        asked.push(prompt);
        return "confirmed";
      },
      cancel() {},
    };
    const h = helper({ ok: true, hash: "b".repeat(64) });
    await executeAction("browser.sign", { ...SIGN, confirmation: "none" }, CONTEXT, {
      tabs: tabs(),
      content: content(),
      confirm,
      sign: { helper: h.port, sha256Hex },
    });
    expect(asked).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
  });

  it("manual mode asks first and does not touch the helper when the person refuses", async () => {
    const prompts: string[] = [];
    const confirm: ConfirmationPort = {
      async request(prompt) {
        prompts.push(prompt.summary);
        return "refused";
      },
      cancel() {},
    };
    const h = helper({ ok: true, hash: "c".repeat(64) });
    const outcome = await executeAction("browser.sign", { ...SIGN, confirmation: "human" }, CONTEXT, {
      tabs: tabs(),
      content: content(),
      confirm,
      sign: { helper: h.port, sha256Hex },
    });
    expect(prompts).toEqual([`browser.sign → ${SIGN.documentRef} (sign)`]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32019);
    expect(h.requests).toHaveLength(0);
  });

  it("manual mode signs after the person confirms", async () => {
    const confirm: ConfirmationPort = { async request() { return "confirmed"; }, cancel() {} };
    const h = helper({ ok: true, hash: "d".repeat(64) });
    const outcome = await executeAction("browser.sign", { ...SIGN, confirmation: "human" }, CONTEXT, {
      tabs: tabs(),
      content: content(),
      confirm,
      sign: { helper: h.port, sha256Hex },
    });
    expect(outcome.ok).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("reports a refusal with the document digest when the CSP step is cancelled", async () => {
    const h = helper({ ok: false, error: "cancelled" });
    const outcome = await executeAction("browser.sign", SIGN, CONTEXT, {
      tabs: tabs(),
      content: content(),
      sign: { helper: h.port, sha256Hex },
    });
    expect(outcome).toEqual({ ok: true, result: { status: "refused", documentHash: SHA } });
  });

  it("fails with the helper error code, never with a signature, when the helper breaks", async () => {
    for (const error of ["pin_unavailable", "middleware_error", "helper_unavailable"] as const) {
      const h = helper({ ok: false, error, message: "secret-looking detail" });
      const outcome = await executeAction("browser.sign", SIGN, CONTEXT, {
        tabs: tabs(),
        content: content(),
        sign: { helper: h.port, sha256Hex },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe(-32603);
        expect(outcome.data).toEqual({ helperError: error });
        expect(outcome.message).not.toContain("secret-looking detail");
      }
    }
  });

  it("fails closed in a build without the signing port", async () => {
    const outcome = await executeAction("browser.sign", SIGN, CONTEXT, { tabs: tabs(), content: content() });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32603);
  });

  it("refuses without the sign capability", async () => {
    const h = helper({ ok: true, hash: "e".repeat(64) });
    const outcome = await executeAction("browser.sign", SIGN, { ...CONTEXT, capabilities: ["read"] }, {
      tabs: tabs(),
      content: content(),
      sign: { helper: h.port, sha256Hex },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32012);
    expect(h.requests).toHaveLength(0);
  });

  it("validates params before anything is fetched or signed", async () => {
    const h = helper({ ok: true, hash: "f".repeat(64) });
    const ports = { tabs: tabs(), content: content(), sign: { helper: h.port, sha256Hex } };
    const bad = [
      { ...SIGN, documentRef: "" },
      { ...SIGN, actionType: "application.submit" },
      { ...SIGN, actionType: undefined },
      { ...SIGN, url: undefined },
    ];
    for (const params of bad) {
      const outcome = await executeAction("browser.sign", params, CONTEXT, ports);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(-32602);
    }
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a document url or an active tab outside the allowlist", async () => {
    const h = helper({ ok: true, hash: "f".repeat(64) });
    const foreignUrl = await executeAction("browser.sign", { ...SIGN, url: "https://other.example/a.pdf" }, CONTEXT, {
      tabs: tabs(),
      content: content(),
      sign: { helper: h.port, sha256Hex },
    });
    expect(foreignUrl.ok).toBe(false);
    if (!foreignUrl.ok) expect(foreignUrl.code).toBe(-32013);
    const foreignTab = await executeAction("browser.sign", SIGN, CONTEXT, {
      tabs: tabs("https://other.example/"),
      content: content(),
      sign: { helper: h.port, sha256Hex },
    });
    expect(foreignTab.ok).toBe(false);
    if (!foreignTab.ok) expect(foreignTab.code).toBe(-32013);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a document above the bridge ceiling without calling the helper", async () => {
    const h = helper({ ok: true, hash: "f".repeat(64) });
    const outcome = await executeAction("browser.sign", SIGN, CONTEXT, {
      tabs: tabs(),
      content: content({ byteLength: 26 * 1024 * 1024 }),
      sign: { helper: h.port, sha256Hex },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(-32021);
    expect(h.requests).toHaveLength(0);
  });
});

describe("native sign helper client", () => {
  const request: SignHelperRequest = { actionType: "sign", documentRef: "ref", bytesBase64: BYTES_B64 };

  it("sends a contract-shaped message to the registered host and returns the validated answer", async () => {
    const sent: Array<{ host: string; message: unknown }> = [];
    const client = createNativeSignHelper(
      async (host, message) => {
        sent.push({ host, message });
        return { type: "sign_result", id: 7, result: { ok: true, hash: "a".repeat(64), signatureBase64: "U0lH" } };
      },
      { nextId: () => 7 },
    );
    expect(await client.sign(request)).toEqual({ ok: true, hash: "a".repeat(64), signatureBase64: "U0lH" });
    expect(sent).toEqual([
      {
        host: "com.myrmidon.sign_helper",
        message: { type: "sign", id: 7, actionType: "sign", documentRef: "ref", document: { kind: "bytes", bytesBase64: BYTES_B64 } },
      },
    ]);
  });

  it("passes through a helper failure code", async () => {
    const client = createNativeSignHelper(async () => ({
      type: "sign_result",
      id: 1,
      result: { ok: false, error: "pin_unavailable" },
    }));
    expect(await client.sign(request)).toEqual({ ok: false, error: "pin_unavailable" });
  });

  it("treats a missing host, a wrong id and a malformed answer as helper_unavailable", async () => {
    const missing = createNativeSignHelper(async () => {
      throw new Error("Specified native messaging host not found.");
    });
    expect(await missing.sign(request)).toMatchObject({ ok: false, error: "helper_unavailable" });

    const wrongId = createNativeSignHelper(
      async () => ({ type: "sign_result", id: 99, result: { ok: true, hash: "a".repeat(64) } }),
      { nextId: () => 1 },
    );
    expect(await wrongId.sign(request)).toMatchObject({ ok: false, error: "helper_unavailable" });

    const malformed = createNativeSignHelper(async () => ({ type: "sign_result", id: 1, result: { ok: true, hash: "zz" } }), {
      nextId: () => 1,
    });
    expect(await malformed.sign(request)).toMatchObject({ ok: false, error: "helper_unavailable" });
  });

  it("gives up after the timeout when the helper never answers", async () => {
    let fire: (() => void) | undefined;
    const client = createNativeSignHelper(() => new Promise(() => {}), {
      timers: {
        setTimeout(fn) {
          fire = fn;
          return 1;
        },
        clearTimeout() {},
      },
    });
    const pending = client.sign(request);
    await Promise.resolve();
    fire?.();
    expect(await pending).toMatchObject({ ok: false, error: "helper_unavailable" });
  });
});

describe("signature stash", () => {
  it("keeps a bounded number of signatures, oldest dropped first", () => {
    const stash = createSignatureStash(2);
    stash.put("h1", "s1");
    stash.put("h2", "s2");
    stash.put("h3", "s3");
    expect(stash.take("h1")).toBeNull();
    expect(stash.take("h2")).toBe("s2");
    expect(stash.take("h3")).toBe("s3");
  });
});
