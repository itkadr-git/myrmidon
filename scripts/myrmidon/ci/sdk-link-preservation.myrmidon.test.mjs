import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { linkSdkInto } from "../../link-plugin-dev-sdk.mjs";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/plugins/sdk");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), "cache", "scratch");

function fixture(t, name = "package") {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "sdk-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, name);
  mkdirSync(pkg, { recursive: true });
  const scope = join(pkg, "node_modules", "@myrmidon");
  return { root, pkg, scope, target: join(scope, "plugin-sdk") };
}

function assertSdkLink(target) {
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  const link = readlinkSync(target);
  assert.equal(link, relative(dirname(target), sdk));
  assert.equal(resolve(dirname(target), link), sdk);
}

test("preserves an installed SDK directory and its exact bytes", (t) => {
  const f = fixture(t);
  mkdirSync(f.target, { recursive: true });
  const files = ["package.json", "sentinel"];
  const contents = [Buffer.from('{"name":"installed"}\n'), Buffer.from([0, 1, 255])];
  files.forEach((file, i) => writeFileSync(join(f.target, file), contents[i]));
  const inode = lstatSync(f.target).ino;
  assert.equal(linkSdkInto(f.pkg), false);
  assert.equal(lstatSync(f.target).isDirectory(), true);
  assert.equal(lstatSync(f.target).ino, inode);
  files.forEach((file, i) => assert.deepEqual(readFileSync(join(f.target, file)), contents[i]));
});

test("preserves an ordinary file occupying the SDK target", (t) => {
  const f = fixture(t);
  mkdirSync(f.scope, { recursive: true });
  const data = Buffer.from([0, 20, 255]);
  writeFileSync(f.target, data);
  const inode = lstatSync(f.target).ino;
  assert.equal(linkSdkInto(f.pkg), false);
  assert.equal(lstatSync(f.target).isFile(), true);
  assert.equal(lstatSync(f.target).ino, inode);
  assert.deepEqual(readFileSync(f.target), data);
});

test("leaves the correct relative link unchanged", (t) => {
  const f = fixture(t);
  mkdirSync(f.scope, { recursive: true });
  const link = relative(f.scope, sdk);
  symlinkSync(link, f.target, "dir");
  const inode = lstatSync(f.target).ino;
  assert.equal(linkSdkInto(f.pkg), false);
  assert.equal(lstatSync(f.target).ino, inode);
  assert.equal(readlinkSync(f.target), link);
  assertSdkLink(f.target);
});

test("replaces a stale link without deleting its former target", (t) => {
  const f = fixture(t);
  const old = join(f.root, "old-sdk");
  mkdirSync(old);
  mkdirSync(f.scope, { recursive: true });
  const sentinel = Buffer.from("old SDK remains\n");
  writeFileSync(join(old, "sentinel"), sentinel);
  symlinkSync(relative(f.scope, old), f.target, "dir");
  assert.equal(linkSdkInto(f.pkg), true);
  assertSdkLink(f.target);
  assert.deepEqual(readFileSync(join(old, "sentinel")), sentinel);
});

test("replaces a dangling link without creating its missing target", (t) => {
  const f = fixture(t);
  mkdirSync(f.scope, { recursive: true });
  const missing = join(f.root, "missing-sdk");
  symlinkSync(relative(f.scope, missing), f.target, "dir");
  assert.equal(existsSync(f.target), false);
  assert.equal(linkSdkInto(f.pkg), true);
  assertSdkLink(f.target);
  assert.equal(existsSync(missing), false);
});

test("preserves a neighboring scoped package when creating the link", (t) => {
  const f = fixture(t);
  const neighbor = join(f.scope, "neighbor");
  mkdirSync(neighbor, { recursive: true });
  const sentinel = Buffer.from("neighbor data\n");
  writeFileSync(join(neighbor, "package.json"), sentinel);
  const inode = lstatSync(neighbor).ino;
  assert.equal(linkSdkInto(f.pkg), true);
  assertSdkLink(f.target);
  assert.equal(lstatSync(neighbor).ino, inode);
  assert.deepEqual(readFileSync(join(neighbor, "package.json")), sentinel);
});

test("links correctly inside nested package paths with spaces", (t) => {
  const f = fixture(t, "nested folder/package with spaces");
  assert.equal(linkSdkInto(f.pkg), true);
  assertSdkLink(f.target);
  assert.equal(linkSdkInto(f.pkg), false);
});

test("creates missing node_modules and scope directories", (t) => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.pkg, "node_modules")), false);
  assert.equal(linkSdkInto(f.pkg), true);
  assert.equal(lstatSync(f.scope).isDirectory(), true);
  assertSdkLink(f.target);
});

test("a second call after replacement is a no-op", (t) => {
  const f = fixture(t);
  mkdirSync(f.scope, { recursive: true });
  symlinkSync("nonexistent", f.target, "dir");
  assert.equal(linkSdkInto(f.pkg), true);
  assertSdkLink(f.target);
  const inode = lstatSync(f.target).ino;
  const link = readlinkSync(f.target);
  assert.equal(linkSdkInto(f.pkg), false);
  assert.equal(lstatSync(f.target).ino, inode);
  assert.equal(readlinkSync(f.target), link);
  assertSdkLink(f.target);
});
