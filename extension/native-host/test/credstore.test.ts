import { test } from "node:test";
import assert from "node:assert/strict";
import { windowsCredentialStore, type PowerShellRunner } from "../src/credstore.ts";

function recordingRunner(): PowerShellRunner & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    async exec(script) {
      scripts.push(script);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

test("readPin returns null when the credential is absent (exit 3)", async () => {
  const store = windowsCredentialStore({
    async exec() {
      return { code: 3, stdout: "", stderr: "not found" };
    },
  });
  assert.equal(await store.readPin("Myrmidon/SignHelper/token-1"), null);
});

test("readPin decodes the base64 blob from stdout", async () => {
  const pin = Buffer.from("1234");
  const store = windowsCredentialStore({
    async exec() {
      return { code: 0, stdout: `${pin.toString("base64")}\n`, stderr: "" };
    },
  });
  const read = await store.readPin("Myrmidon/SignHelper/token-1");
  assert.equal(read?.toString("utf8"), "1234");
});

test("writePin passes a base64 blob to CredWrite", async () => {
  const runner = recordingRunner();
  const store = windowsCredentialStore(runner);
  await store.writePin("Myrmidon/SignHelper/token-1", Buffer.from("1234"));
  assert.equal(runner.scripts.length, 1);
  assert.match(runner.scripts[0]!, /CredWrite/);
  assert.match(runner.scripts[0]!, /'MTIzNA=='/);
  assert.doesNotMatch(runner.scripts[0]!, /1234/);
});

test("writePin propagates failure", async () => {
  const store = windowsCredentialStore({
    async exec() {
      return { code: 1, stdout: "", stderr: "denied" };
    },
  });
  await assert.rejects(() => store.writePin("target", Buffer.from("x")), /CredWrite failed/);
});

test("script target strings are single-quoted and escaped", async () => {
  const runner = recordingRunner();
  const store = windowsCredentialStore(runner);
  await store.readPin("weird'target");
  assert.match(runner.scripts[0]!, /'weird''target'/);
  assert.doesNotMatch(runner.scripts[0]!, /weird'target'/);
});
