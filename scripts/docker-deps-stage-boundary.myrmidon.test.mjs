import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./check-docker-deps-stage.mjs", import.meta.url));
const manifest = "packages/widget/package.json";
const copy = `COPY ${manifest} ${manifest}`;
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");

function snapshot(root, relative = "") {
  return readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = path.join(relative, entry.name);
      return entry.isDirectory() ? snapshot(root, name) : [[name, readFileSync(path.join(root, name), "utf8")]];
    });
}

function runFixture(dockerfile, expected) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "deps-stage-"));
  try {
    mkdirSync(path.join(root, "packages/widget"), { recursive: true });
    writeFileSync(path.join(root, "Dockerfile"), dockerfile);
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(path.join(root, manifest), '{"name":"widget"}\n');
    const before = snapshot(root);
    const child = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.ifError(child.error);
    assert.deepEqual(snapshot(root), before, "CLI must not change fixture files");
    assert.equal(child.status, expected.status, `stdout: ${child.stdout}\nstderr: ${child.stderr}`);
    if (expected.status === 0) {
      assert.equal(child.stdout.trim(), "PASS");
      assert.equal(child.stderr, "");
    } else {
      assert.equal(child.stdout, "");
      assert.doesNotMatch(child.stdout + child.stderr, /\bPASS\b/);
      assert.match(child.stderr, expected.error);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const extractError = /Could not extract deps stage from Dockerfile/;
const missingError = /Dockerfile deps stage missing package manifest coverage for: packages\/widget\/package\.json/;

test("rejects a Dockerfile without a deps stage", () => {
  runFixture(`FROM node AS builder\n${copy}\n`, { status: 1, error: extractError });
});

test("rejects an empty deps stage", () => {
  runFixture("FROM node AS deps\nFROM node AS runtime\n", { status: 1, error: extractError });
});

test("accepts lowercase stage keywords", () => {
  runFixture(`from node as deps\n${copy}\n`, { status: 0 });
});

test("accepts surrounding whitespace on stage boundaries", () => {
  runFixture(`  FROM node AS deps  \n${copy}\n  FROM node AS runtime  \n`, { status: 0 });
});

test("does not count a manifest COPY in the previous builder stage", () => {
  runFixture(`FROM node AS builder\n${copy}\nFROM node AS deps\nRUN true\n`, { status: 1, error: missingError });
});

test("does not count a manifest COPY in the next runtime stage", () => {
  runFixture(`FROM node AS deps\nRUN true\nFROM node AS runtime\n${copy}\n`, { status: 1, error: missingError });
});

test("counts the same manifest COPY inside deps", () => {
  runFixture(`FROM node AS builder\nRUN true\nFROM node AS deps\n${copy}\nFROM node AS runtime\nRUN true\n`, { status: 0 });
});
