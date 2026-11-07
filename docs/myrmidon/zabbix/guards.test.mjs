#!/usr/bin/env node
import fs from "node:fs";
import assert from "node:assert/strict";

const configPath = new URL("./guards.json", import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

assert.equal(config.schemaVersion, 1);
assert.equal(config.owner, "adm");
assert.equal(config.delivery.mode, "adm_only");
assert.equal(config.delivery.target, "adm");
assert.equal(config.delivery.liveActions, false);
assert.equal(config.items.length, 2);
assert.equal(config.triggers.length, 2);

const idle = config.items.find((item) => item.id === "eng-idle");
assert.ok(idle);
assert.equal(idle.key, "myrmidon.eng.idle.count");
const idleTrigger = config.triggers.find((trigger) => trigger.id === "eng-idle-high");
assert.ok(idleTrigger);
assert.match(idleTrigger.expression, />=3/);

const disk = config.items.find((item) => item.id === "myrmidon-xfs-free");
assert.ok(disk);
assert.equal(disk.key, "vfs.fs.size[/srv/myrmidon-xfs,pfree]");
const diskTrigger = config.triggers.find((trigger) => trigger.id === "myrmidon-xfs-low");
assert.ok(diskTrigger);
assert.match(diskTrigger.expression, /<15/);
assert.match(diskTrigger.expression, /srv\/myrmidon-xfs/);

for (const item of config.items) {
  assert.ok(item.name && item.key && item.description);
}
for (const trigger of config.triggers) {
  assert.ok(trigger.name && trigger.expression && trigger.description && trigger.operatorAction);
}

console.log("Zabbix guard configuration is valid");
