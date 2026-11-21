import assert from "node:assert/strict";
import { test } from "node:test";
import { appendOwnedFleetResource, parseFleetOwnershipInventory } from "./myrmidon-owned-resources.ts";

const company = "11111111-1111-4111-8111-111111111111";
const server = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const container = { kind: "role_container", containerId: "a".repeat(64) };

test("records all resource kinds and survives a JSON persistence round trip", () => {
  let inventory = appendOwnedFleetResource(null, company, server, job, container);
  inventory = appendOwnedFleetResource(inventory, company, server, job, { kind: "ssh_key", username: "root", authorizedKey: "ssh-ed25519 AAAA myrmidon" });
  inventory = appendOwnedFleetResource(inventory, company, server, job, { kind: "firewall_rule", backend: "ufw", rule: "allow 22/tcp", marker: `myrmidon:${company}:${server}` });
  assert.deepEqual(parseFleetOwnershipInventory(JSON.parse(JSON.stringify(inventory)), company, server), inventory);
  assert.equal(inventory.resources.length, 3);
});

test("retries are idempotent and cannot overwrite earlier ownership", () => {
  const inventory = appendOwnedFleetResource(null, company, server, job, container);
  assert.deepEqual(appendOwnedFleetResource(inventory, company, server, job, container), inventory);
  const next = appendOwnedFleetResource(inventory, company, server, job, { kind: "role_container", containerId: "b".repeat(64) });
  assert.equal(next.resources.length, 2);
  assert.equal(inventory.resources.length, 1);
});

test("rejects missing, malformed, cross-company and cross-server inventory", () => {
  const inventory = appendOwnedFleetResource(null, company, server, job, container);
  for (const value of [null, {}, { ...inventory, version: 2 }, { ...inventory, companyId: server }, { ...inventory, serverId: company }]) {
    assert.throws(() => parseFleetOwnershipInventory(value, company, server));
  }
});

test("rejects selectors, shell syntax, extra fields and foreign firewall markers", () => {
  for (const resource of [
    { kind: "role_container", containerId: "myrmidon-*" },
    { kind: "role_container", containerId: "a".repeat(12) },
    { ...container, command: "docker rm -f $(docker ps -aq)" },
    { kind: "ssh_key", username: "root", authorizedKey: "ssh-ed25519 AAAA\nssh-ed25519 BBBB" },
    { kind: "ssh_key", username: "../root", authorizedKey: "ssh-ed25519 AAAA" },
    { kind: "firewall_rule", backend: "ufw", rule: "allow 99999/tcp", marker: `myrmidon:${company}:${server}` },
    { kind: "firewall_rule", backend: "ufw", rule: "allow 22/tcp; ufw disable", marker: `myrmidon:${company}:${server}` },
    { kind: "firewall_rule", backend: "ufw", rule: "allow 22/tcp", marker: `myrmidon:${server}:${company}` },
  ]) assert.throws(() => appendOwnedFleetResource(null, company, server, job, resource));
});

test("null is not an authoritative empty inventory for decommission", () => {
  assert.throws(() => parseFleetOwnershipInventory(null, company, server));
  assert.deepEqual(parseFleetOwnershipInventory({ version: 1, companyId: company, serverId: server, resources: [] }, company, server).resources, []);
});
