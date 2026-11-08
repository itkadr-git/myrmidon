#!/usr/bin/env node
import fs from "node:fs";
import assert from "node:assert/strict";

const configPath = new URL("./guards.json", import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

assert.equal(config.schemaVersion, 2);
assert.equal(config.owner, "adm");
assert.equal(config.delivery.mode, "adm_only");
assert.equal(config.delivery.target, "adm");
assert.equal(config.delivery.liveActions, false);
assert.equal(config.items.length, 7);
assert.equal(config.triggers.length, 8);

// Existing OPE-9868 guards
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

// OPE-11780 replacements
// 1. oom-watch replacement
const kernelOom = config.items.find((item) => item.id === "kernel-oom");
assert.ok(kernelOom);
assert.match(kernelOom.key, /log\[/);
const oomTrigger = config.triggers.find((trigger) => trigger.id === "kernel-oom-detected");
assert.ok(oomTrigger);
assert.match(oomTrigger.expression, /oom-killer/);

// 2. disk-watch-board replacement (10% threshold rule per Alex)
const rootFree = config.items.find((item) => item.id === "root-free");
assert.ok(rootFree);
assert.equal(rootFree.key, "vfs.fs.size[/,pfree]");
const diskCritical = config.triggers.find((trigger) => trigger.id === "myrmidon-xfs-critical");
assert.ok(diskCritical);
assert.match(diskCritical.expression, /<10/);
const rootCritical = config.triggers.find((trigger) => trigger.id === "root-low-critical");
assert.ok(rootCritical);
assert.match(rootCritical.expression, /<10/);

// 3. vmcore-buildcache-guard replacement
const buildcacheItem = config.items.find((item) => item.id === "vmcore-buildcache-size");
assert.ok(buildcacheItem);
const buildcacheTrigger = config.triggers.find((trigger) => trigger.id === "vmcore-buildcache-detected");
assert.ok(buildcacheTrigger);

// 4. vmcore-timers-watch replacement
const timersItem = config.items.find((item) => item.id === "systemd-failed-units");
assert.ok(timersItem);
const timersTrigger = config.triggers.find((trigger) => trigger.id === "systemd-timers-failed");
assert.ok(timersTrigger);

// 5. vmcore-stub-watch replacement
const pingItem = config.items.find((item) => item.id === "agent-availability");
assert.ok(pingItem);
const pingTrigger = config.triggers.find((trigger) => trigger.id === "agent-unavailable");
assert.ok(pingTrigger);

// Decommission targets verification
assert.ok(Array.isArray(config.decommissionTargets));
assert.equal(config.decommissionTargets.length, 5);
const expectedTargets = [
  "oom-watch",
  "disk-watch-board",
  "vmcore-buildcache-guard",
  "vmcore-timers-watch",
  "vmcore-stub-watch"
];
for (const targetId of expectedTargets) {
  const target = config.decommissionTargets.find((t) => t.id === targetId);
  assert.ok(target, `Missing decommission target ${targetId}`);
  assert.ok(target.service && target.timer && target.scriptPath && target.replacementTriggerId);
}

for (const item of config.items) {
  assert.ok(item.name && item.key && item.description);
}
for (const trigger of config.triggers) {
  assert.ok(trigger.name && trigger.expression && trigger.description && trigger.operatorAction);
}

console.log("Zabbix guard configuration is valid");
