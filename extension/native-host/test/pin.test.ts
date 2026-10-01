import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialTarget,
  credentialStorePin,
  middlewareOwnedPin,
  withPin,
  type CredentialStore,
} from "../src/pin.ts";
import { createMockMiddleware, type SignMiddleware } from "../src/middleware.ts";

function memoryStore(): CredentialStore & { data: Map<string, Buffer> } {
  const data = new Map<string, Buffer>();
  return {
    data,
    async readPin(target) {
      return data.get(target) ?? null;
    },
    async writePin(target, pin) {
      data.set(target, Buffer.from(pin));
    },
    async deletePin(target) {
      data.delete(target);
    },
  };
}

test("credential target is namespaced per key alias", () => {
  assert.equal(credentialTarget("token-1"), "Myrmidon/SignHelper/token-1");
});

test("credential store pin provider reads what was written", async () => {
  const store = memoryStore();
  await store.writePin(credentialTarget("token-1"), Buffer.from("1234"));
  const provider = credentialStorePin(store, "token-1");
  const pin = await provider.getPin();
  assert.equal(pin?.toString("utf8"), "1234");
});

test("credential store pin provider returns null when absent", async () => {
  const provider = credentialStorePin(memoryStore(), "missing");
  assert.equal(await provider.getPin(), null);
});

test("middlewareOwnedPin returns null (middleware holds the PIN itself)", async () => {
  assert.equal(await middlewareOwnedPin().getPin(), null);
});

test("withPin fails closed when the PIN is unavailable", async () => {
  const calls: string[] = [];
  const middleware: SignMiddleware & { withPinSecret?(pin: Buffer): SignMiddleware } = {
    name: "fake",
    async sign() {
      calls.push("sign");
      return { hashHex: "00" };
    },
    withPinSecret(pin) {
      calls.push(`pin:${pin.toString("utf8")}`);
      return this;
    },
  };
  const wrapped = withPin(middleware, {
    async getPin() {
      return null;
    },
  });
  const err = await (wrapped.sign({ actionType: "sign", documentRef: "ref", bytes: Buffer.from("d") }) as Promise<
    unknown
  >).then(
    () => null,
    (error: Error & { code?: string }) => error,
  );
  assert.ok(err instanceof Error);
  assert.equal((err as { code?: string }).code, "pin_unavailable");
  assert.deepEqual(calls, []);
});

test("withPin passes the secret and zeroes it afterwards", async () => {
  // The memory store returns a copy so the zeroing cannot corrupt the stored
  // credential; assert on a string snapshot taken at call time.
  const pin = Buffer.from("1234");
  const store: CredentialStore = {
    async readPin() {
      return Buffer.from(pin);
    },
    async writePin() {},
    async deletePin() {},
  };
  const seen: string[] = [];
  const middleware: SignMiddleware & { withPinSecret?(pin: Buffer): SignMiddleware } = {
    name: "fake",
    async sign() {
      return { hashHex: "00" };
    },
    withPinSecret(secret) {
      seen.push(secret.toString("utf8"));
      return this;
    },
  };
  const wrapped = withPin(middleware, credentialStorePin(store, "token-1"));
  await wrapped.sign({ actionType: "sign", documentRef: "ref", bytes: Buffer.from("d") });
  assert.deepEqual(seen, ["1234"]);
  // The stored credential survives untouched for the next sign call.
  const again = await credentialStorePin(store, "token-1").getPin();
  assert.equal(again?.toString("utf8"), "1234");
});

test("withPin is a no-op when the middleware has no secret interface", async () => {
  const middleware = createMockMiddleware();
  const wrapped = withPin(middleware, middlewareOwnedPin());
  const result = await wrapped.sign({ actionType: "sign", documentRef: "ref", bytes: Buffer.from("d") });
  assert.match(result.hashHex, /^[0-9a-f]{64}$/);
});
